/**
 * The models a provider offers, for the Settings model picker. Port of the CLI's
 * `archymedes-cli/src/session/models.ts` (`modelsForProvider`, `buildModelCatalog`) and
 * `core/src/providers/model-fetch.ts` (fetching and the 6h cache).
 *
 * The list is the union of two sources, and neither is dropped:
 * - the price catalog, which knows rates and is always available, and
 * - the provider's own `/v1/models`, which knows what exists today.
 *
 * Keys are used only for the request to the provider's own host; they are never logged, never
 * written to the cache, and never part of a cache key or an error message.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { PRICE_CATALOG } from "./core/price-catalog";
import { catalogPricesOf } from "./core/price-lookup";
import { freeEndpoint, parseFreeModels } from "./agent/free-adapter";
import { PROVIDER_INFO } from "../shared/providers";
import type { ProviderId } from "../shared/providers";
import {
  isConversationalModel,
  isFreeModelId,
  modelsEndpoint,
  OPENROUTER_BASE_URL,
  parseModelsResponse,
  supportsLiveListing,
} from "../shared/model-catalog";
import type { ModelChoice, ModelListing, ModelListRequest } from "../shared/model-catalog";

/**
 * Text models known to this build for one provider: the provider's default first, then every
 * text/token record in the price catalog, sorted. Identical to the CLI's `modelsForProvider`.
 */
export function modelsForProvider(provider: ProviderId): string[] {
  const seen = new Set<string>();
  for (const record of PRICE_CATALOG) {
    if (record.provider !== provider || record.modality !== "text" || record.billingUnit !== "tokens") continue;
    seen.add(record.model);
  }
  const fallback = PROVIDER_INFO[provider].defaultModel;
  seen.add(fallback);
  return [fallback, ...[...seen].filter((model) => model !== fallback).sort()];
}

/** One picker entry, priced the way the CLI's `buildModelCatalog` prices it. */
export function modelChoice(provider: ProviderId, id: string, live: boolean, asOf?: string): ModelChoice {
  const prices = catalogPricesOf(provider, id, asOf);
  return {
    id,
    isDefault: id === PROVIDER_INFO[provider].defaultModel,
    ...(prices ? { price: { currency: prices.currency, inputPerMillion: prices.inputPerMillion, outputPerMillion: prices.outputPerMillion } } : {}),
    ...(live ? { live: true } : {}),
  };
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestRedirect },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type LiveFetchResult = { models: string[]; error?: string };

/** The CLI's per-request deadline for a provider list, and the longer one for the free catalog. */
export const LIST_TIMEOUT_MS = 4_000;
export const FREE_LIST_TIMEOUT_MS = 15_000;

/**
 * Where a request's live list comes from, as a cache key and a request. The key holds the provider
 * and the URL only, never the credential.
 */
export function liveSource(
  request: Pick<ModelListRequest, "provider" | "apiKey" | "baseUrl">,
  environment: Record<string, string | undefined> = process.env,
): { cacheKey: string; url: string; headers: Record<string, string>; free: boolean } | undefined {
  if (request.provider === "free") {
    // Public metadata only: no credential is sent, even when the user has a key. With a gateway
    // configured its listing is read; otherwise OpenRouter's public one (same as the CLI).
    const endpoint = freeEndpoint(request, environment);
    const base = endpoint && !endpoint.apiKey ? endpoint.baseUrl : OPENROUTER_BASE_URL;
    const url = `${base}/models`;
    return { cacheKey: `free ${url}`, url, headers: { accept: "application/json" }, free: true };
  }
  const endpoint = modelsEndpoint(request.provider, request);
  if (!endpoint) return undefined;
  return { cacheKey: `${request.provider} ${endpoint.url}`, url: endpoint.url, headers: endpoint.headers, free: false };
}

/** Asks one provider what it has. Never throws: a failure is a short reason without the key. */
export async function fetchLiveModels(
  source: { url: string; headers: Record<string, string>; free: boolean },
  fetchImpl: FetchLike,
  timeoutMs = source.free ? FREE_LIST_TIMEOUT_MS : LIST_TIMEOUT_MS,
): Promise<LiveFetchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const response = await Promise.race([
      fetchImpl(source.url, {
        method: "GET",
        headers: source.headers,
        signal: controller.signal,
        ...(source.free ? { redirect: "error" as const } : {}),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timed out"));
        }, timeoutMs);
      }),
    ]);
    if (!response.ok) return { models: [], error: `provider returned ${response.status}` };
    const body = await response.json();
    // Free mode lists only explicitly zero-priced, text-producing tool models (fails closed).
    const models = source.free
      ? parseFreeModels(body).map((model) => model.id).filter(isFreeModelId)
      : parseModelsResponse(body).filter(isConversationalModel);
    return { models: [...new Set(models)].sort() };
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** How long a fetched list is trusted (the CLI's MODEL_CACHE_TTL_MS). */
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

type CacheEntry = { fetchedAt: number; models: string[] };
type CacheFile = { version: 1; entries: Record<string, CacheEntry> };

export function isCacheFresh(entry: CacheEntry | undefined, now: number, ttlMs = MODEL_CACHE_TTL_MS): boolean {
  // A cache stamped in the future is a clock that moved, not a fresh cache.
  return Boolean(entry) && entry!.fetchedAt <= now && now - entry!.fetchedAt < ttlMs;
}

export function modelCacheFile(userData: string): string {
  return path.join(userData, "cache", "models.json");
}

/**
 * Lists models for the picker, with a 6h cache held in memory and mirrored to disk under userData.
 * Concurrent requests for the same source share one fetch.
 */
export class ModelListService {
  private memory: Record<string, CacheEntry> | undefined;
  private readonly inFlight = new Map<string, Promise<LiveFetchResult>>();

  constructor(
    private readonly options: {
      cacheFile: string;
      fetchImpl?: FetchLike;
      now?: () => number;
      environment?: Record<string, string | undefined>;
    },
  ) {}

  async list(request: ModelListRequest): Promise<ModelListing> {
    const { provider } = request;
    const knownIds = modelsForProvider(provider);
    const known = knownIds.map((id) => modelChoice(provider, id, false));
    const base = { provider, known };
    if (!supportsLiveListing(provider)) return { ...base, live: [], status: "unsupported" };

    const source = liveSource(request, this.options.environment ?? process.env);
    if (!source) return { ...base, live: [], status: "no-key" };

    const now = (this.options.now ?? Date.now)();
    const cache = await this.readCache();
    const cached = cache[source.cacheKey];
    const toChoices = (models: readonly string[]) => {
      const knownSet = new Set(knownIds);
      // Same filter as `buildModelCatalog`: free mode only ever offers free ids.
      return models
        .filter((id) => !knownSet.has(id) && (provider !== "free" || isFreeModelId(id)))
        .sort()
        .map((id) => modelChoice(provider, id, true));
    };

    if (!request.refresh && isCacheFresh(cached, now)) {
      return { ...base, live: toChoices(cached!.models), status: "ok", fetchedAt: cached!.fetchedAt };
    }

    const result = await this.fetchOnce(source);
    if (result.error) {
      // An older list is still worth showing, marked as failed to refresh.
      return { ...base, live: cached ? toChoices(cached.models) : [], status: "error", error: result.error, ...(cached ? { fetchedAt: cached.fetchedAt } : {}) };
    }
    await this.writeCache({ ...cache, [source.cacheKey]: { fetchedAt: now, models: result.models } });
    return { ...base, live: toChoices(result.models), status: "ok", fetchedAt: now };
  }

  private fetchOnce(source: NonNullable<ReturnType<typeof liveSource>>): Promise<LiveFetchResult> {
    const pending = this.inFlight.get(source.cacheKey);
    if (pending) return pending;
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const promise = fetchLiveModels(source, fetchImpl).finally(() => this.inFlight.delete(source.cacheKey));
    this.inFlight.set(source.cacheKey, promise);
    return promise;
  }

  private async readCache(): Promise<Record<string, CacheEntry>> {
    if (this.memory) return this.memory;
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.cacheFile, "utf8")) as Partial<CacheFile>;
      const entries: Record<string, CacheEntry> = {};
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        for (const [key, entry] of Object.entries(parsed.entries)) {
          if (typeof entry?.fetchedAt === "number" && Array.isArray(entry.models)) {
            entries[key] = { fetchedAt: entry.fetchedAt, models: entry.models.filter((m): m is string => typeof m === "string") };
          }
        }
      }
      this.memory = entries;
    } catch {
      // No cache, unreadable cache, or an older shape: all mean "fetch again".
      this.memory = {};
    }
    return this.memory;
  }

  private async writeCache(entries: Record<string, CacheEntry>): Promise<void> {
    this.memory = entries;
    const file = this.options.cacheFile;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Through a temp file: a half-written cache is worse than none.
      const temporary = `${file}.${process.pid}.tmp`;
      const body: CacheFile = { version: 1, entries };
      await fs.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
    } catch {
      // A cache that cannot be written costs a fetch next time and nothing else.
    }
  }
}
