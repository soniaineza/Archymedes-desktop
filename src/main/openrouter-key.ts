import { createHash } from "node:crypto";
import type { FreeKeyCheck, FreeKeyInfo } from "../shared/types";

/**
 * OpenRouter's key endpoint, used to test a key from Settings and to show how many free-model
 * requests are left today. Documented at https://openrouter.ai/docs/api/reference/limits:
 * `GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer <key>` returns
 * `{ data: { label, limit, limit_remaining, usage, usage_daily, ..., is_free_tier,
 * free_model_daily_requests: { used, limit, remaining } } }`.
 *
 * The key goes only to this fixed host, is never logged, and is never part of any result.
 */
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
/** Documented free-model daily limit for accounts that bought less than 10 credits (same page). */
export const FREE_TIER_DAILY_REQUESTS = 50;
const KEY_TIMEOUT_MS = 8_000;
export const KEY_INFO_TTL_MS = 60_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/** The parts of the key endpoint's body free mode shows; anything missing or malformed is left out. */
export function parseKeyInfo(body: unknown): FreeKeyInfo {
  const data = (body as { data?: unknown } | null)?.data;
  const row = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const daily = row.free_model_daily_requests && typeof row.free_model_daily_requests === "object"
    ? (row.free_model_daily_requests as Record<string, unknown>)
    : {};
  const isFreeTier = typeof row.is_free_tier === "boolean" ? row.is_free_tier : undefined;
  const used = count(daily.used);
  let limit = count(daily.limit);
  let remaining = count(daily.remaining);
  // An account that never bought credits has the documented 50/day limit even when the endpoint
  // omits the counter. A paying account's limit depends on how much it bought, so it stays unknown.
  if (limit === undefined && isFreeTier === true) limit = FREE_TIER_DAILY_REQUESTS;
  if (remaining === undefined && limit !== undefined && used !== undefined) remaining = Math.max(0, limit - used);
  return {
    ...(isFreeTier !== undefined ? { isFreeTier } : {}),
    ...(limit !== undefined ? { dailyRequestLimit: limit } : {}),
    ...(used !== undefined ? { dailyRequestsUsed: used } : {}),
    ...(remaining !== undefined ? { dailyRequestsRemaining: remaining } : {}),
  };
}

/** Asks OpenRouter about a key. Never throws; failures come back as a reason the UI can explain. */
export async function checkOpenRouterKey(
  apiKey: string,
  options: { fetchImpl?: Fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FreeKeyCheck> {
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: "empty" };
  // Header values cannot carry control characters; such a "key" was mis-pasted.
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return { ok: false, reason: "invalid-key" };
  const timeout = AbortSignal.timeout(options.timeoutMs ?? KEY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(OPENROUTER_KEY_URL, {
      method: "GET",
      signal,
      redirect: "error",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "invalid-key", status: response.status };
  if (response.status === 429) return { ok: false, reason: "rate-limited", status: 429 };
  if (!response.ok) return { ok: false, reason: "server", status: response.status };
  try {
    return { ok: true, info: parseKeyInfo(await response.json()) };
  } catch {
    return { ok: false, reason: "server", status: response.status };
  }
}

/**
 * The key's free-model allowance for the status bar, cached for a minute per key. Requests made
 * since the last fetch are subtracted locally, so the figure moves with each request in between.
 */
export class KeyInfoService {
  private cache: { hash: string; at: number; info: FreeKeyInfo | null; since: number } | null = null;
  private inflight: { hash: string; promise: Promise<FreeKeyInfo | null> } | null = null;

  constructor(
    private readonly options: { fetchImpl?: Fetch; now?: () => number; ttlMs?: number; timeoutMs?: number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async get(apiKey: string): Promise<FreeKeyInfo | null> {
    const key = apiKey.trim();
    if (!key) return null;
    const hash = hashOf(key);
    const cached = this.cache;
    if (cached && cached.hash === hash && this.now() - cached.at < (this.options.ttlMs ?? KEY_INFO_TTL_MS)) return adjust(cached.info, cached.since);
    if (this.inflight?.hash === hash) return this.inflight.promise;
    const promise = checkOpenRouterKey(key, { fetchImpl: this.options.fetchImpl, timeoutMs: this.options.timeoutMs }).then((result) => {
      // A failed lookup is cached too, so a bad network does not mean a request on every refresh.
      const info = result.ok ? result.info : null;
      this.cache = { hash, at: this.now(), info, since: 0 };
      return info;
    }).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { hash, promise };
    return promise;
  }

  /** One free-model request was sent with this key. */
  noteRequest(apiKey: string): void {
    if (this.cache && this.cache.hash === hashOf(apiKey.trim())) this.cache.since += 1;
  }

  /** Forget everything, e.g. after the key changes. */
  clear(): void {
    this.cache = null;
  }
}

function adjust(info: FreeKeyInfo | null, since: number): FreeKeyInfo | null {
  if (!info || since === 0) return info;
  return {
    ...info,
    ...(info.dailyRequestsUsed !== undefined ? { dailyRequestsUsed: info.dailyRequestsUsed + since } : {}),
    ...(info.dailyRequestsRemaining !== undefined ? { dailyRequestsRemaining: Math.max(0, info.dailyRequestsRemaining - since) } : {}),
  };
}

/** The cache is keyed by a hash, so the key itself is not kept around any longer than needed. */
function hashOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
