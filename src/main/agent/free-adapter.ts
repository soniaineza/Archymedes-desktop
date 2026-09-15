/**
 * Free mode for the desktop app, ported from the CLI's `free-agent.ts`. With the user's own
 * OpenRouter key requests go only to OpenRouter; without one they go to the Archymedes free gateway,
 * which holds a key server-side. Either way only verified zero-priced tool models are used, every
 * request carries a zero price cap with fallbacks off, and nothing ever falls back to a paid model.
 */
import type { ProviderSettings } from "../../shared/types";
import type { AdapterEvent, AgentAdapter, RuntimeTurn, ToolSchema } from "./adapter";

export const FREE_ROUTER = "openrouter/free";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** The official hosted gateway; empty until deployed (mirrors the CLI's `FREE_GATEWAY_URL`). */
export const FREE_GATEWAY_URL = "";

/** Router order, probed 2026-09-15 for real tool calls (same list as the CLI). */
const PREFERENCE = [
  "cohere/north-mini-code:free",
  "google/gemma-4-31b-it:free",
  "dots-studio/dots-3-note-preview:free",
  "nex-agi/nex-n2.5-pro:free",
  "nvidia/nemotron-3.5-lightning:free",
  "google/gemma-4-26b-a4b-it:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "poolside/laguna-xs-2.1:free",
];
const MAX_ATTEMPTS = 4;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 8_192;

export type FreeModel = { id: string; contextWindow: number; maxOutput: number | null };
export type FreeEndpoint = { baseUrl: string; apiKey?: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function isFreeModelId(id: string): boolean {
  return id === FREE_ROUTER || (id.length <= 256 && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(id));
}

function gatewayUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value?.trim() ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && local))) return undefined;
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Where free requests go. A key is sent only to OpenRouter's fixed host, never to a Base URL
 * override; without a key, Base URL (or ARCHYMEDES_FREE_GATEWAY_URL) names a gateway.
 */
export function freeEndpoint(settings: Pick<ProviderSettings, "apiKey" | "baseUrl">, environment: Record<string, string | undefined> = process.env): FreeEndpoint | undefined {
  const apiKey = settings.apiKey.trim();
  if (apiKey) return { baseUrl: OPENROUTER_BASE_URL, apiKey };
  const configured = settings.baseUrl.trim() || environment.ARCHYMEDES_FREE_GATEWAY_URL?.trim();
  const url = gatewayUrl(configured || FREE_GATEWAY_URL);
  return url ? { baseUrl: `${url}/v1` } : undefined;
}

/** Explicit zero prices, text output and tool support; anything missing fails closed. */
export function parseFreeModels(body: unknown): FreeModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const zero = (value: unknown) => value === 0 || value === "0" || (typeof value === "string" && /^0\.0+$/.test(value));
  const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  const includes = (value: unknown, item: string) => Array.isArray(value) && value.includes(item);
  const positive = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);
  const models: FreeModel[] = [];
  for (const item of data) {
    const row = record(item);
    if (typeof row.id !== "string" || row.id === FREE_ROUTER || !isFreeModelId(row.id)) continue;
    const pricing = record(row.pricing);
    if (!zero(pricing.prompt) || !zero(pricing.completion) || (pricing.request !== undefined && !zero(pricing.request))) continue;
    if (!includes(record(row.architecture).output_modalities, "text") || !includes(row.supported_parameters, "tools")) continue;
    const contextWindow = positive(row.context_length);
    if (!contextWindow) continue;
    models.push({ id: row.id, contextWindow, maxOutput: positive(record(row.top_provider).max_completion_tokens) });
  }
  return models;
}

export function orderCandidates(model: string, eligible: readonly FreeModel[], refused: ReadonlySet<string> = new Set()): FreeModel[] {
  if (model !== FREE_ROUTER) return eligible.filter((candidate) => candidate.id === model);
  const rank = (id: string) => (PREFERENCE.includes(id) ? PREFERENCE.indexOf(id) : PREFERENCE.length);
  return eligible
    .filter((candidate) => !refused.has(candidate.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || b.contextWindow - a.contextWindow || a.id.localeCompare(b.id));
}

const catalogs = new Map<string, { at: number; models: FreeModel[] }>();
/** Models refused (403/404) this app session, per endpoint. */
const refusedModels = new Map<string, Set<string>>();

async function loadCatalog(baseUrl: string, fetchImpl: Fetch, signal: AbortSignal, now: number): Promise<FreeModel[]> {
  const cached = catalogs.get(baseUrl);
  if (cached && now - cached.at < CATALOG_TTL_MS) return cached.models;
  const response = await fetchImpl(`${baseUrl}/models`, { signal, redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parseFreeModels(await response.json());
  catalogs.set(baseUrl, { at: now, models });
  return models;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function friendly(error: unknown, viaGateway: boolean): Error {
  const status = statusOf(error);
  const message = viaGateway
    ? status === 429 ? "Free gateway limit reached. Wait before retrying, or add your own OpenRouter API key."
      : status === 413 ? "The conversation is too large for the free gateway. Start a new session."
      : "The free gateway could not complete the request. Try again later, or add your own OpenRouter API key. No paid fallback was attempted."
    : status === 401 ? "OpenRouter rejected the API key."
      : status === 402 ? "The OpenRouter account's quota or key budget is exhausted."
      : status === 429 ? "OpenRouter free-model rate limit reached. Wait before retrying."
      : status === 403 ? "OpenRouter refused this free model; some are limited to listed apps. Choose another model."
      : "Free model request failed. No paid fallback was attempted.";
  return Object.assign(new Error(message), { status, cause: error });
}

export class FreeAdapter implements AgentAdapter {
  readonly name = "free";

  constructor(
    private readonly settings: ProviderSettings,
    /** `inner` streams one attempt; `adapters.ts` passes its OpenAI-compatible adapter, which keeps this module free of an import cycle. */
    private readonly dependencies: { inner: (settings: ProviderSettings, extraBody: Record<string, unknown>) => AgentAdapter; fetchImpl?: Fetch; now?: () => number; environment?: Record<string, string | undefined> },
  ) {}

  async runTurn(input: { systemPrompt: string; turns: RuntimeTurn[]; tools: ToolSchema[]; onEvent: (event: AdapterEvent) => void; signal: AbortSignal }): Promise<void> {
    const endpoint = freeEndpoint(this.settings, this.dependencies.environment);
    if (!endpoint) throw new Error("Free mode needs an OpenRouter API key, or a free gateway URL in Base URL.");
    const model = this.settings.model.trim() || FREE_ROUTER;
    if (!isFreeModelId(model)) throw new Error("Free mode accepts openrouter/free or an exact publisher/model:free ID. Paid models are not allowed.");
    const viaGateway = !endpoint.apiKey;

    let eligible: FreeModel[];
    try {
      eligible = await loadCatalog(endpoint.baseUrl, this.dependencies.fetchImpl ?? fetch, input.signal, (this.dependencies.now ?? Date.now)());
    } catch (error) {
      if (input.signal.aborted) throw error;
      throw new Error("Could not verify the free model list. Check your connection and retry; no request was sent.");
    }
    const refused = refusedModels.get(endpoint.baseUrl) ?? new Set<string>();
    refusedModels.set(endpoint.baseUrl, refused);
    const candidates = orderCandidates(model, eligible, refused).slice(0, MAX_ATTEMPTS);
    if (candidates.length === 0) throw new Error("No eligible free tool model is available right now. Try again later.");

    let emitted = false;
    const onEvent = (event: AdapterEvent): void => {
      if (event.type === "text-delta" || event.type === "tool-call") emitted = true;
      input.onEvent(event);
    };
    const { inner } = this.dependencies;

    for (const [attempt, candidate] of candidates.entries()) {
      const extraBody = {
        max_tokens: Math.min(MAX_OUTPUT_TOKENS, candidate.maxOutput ?? 4_096),
        provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false },
      };
      try {
        await inner({ ...this.settings, apiKey: endpoint.apiKey ?? "archymedes-free-gateway", baseUrl: endpoint.baseUrl, model: candidate.id }, extraBody).runTurn({ ...input, onEvent });
        return;
      } catch (error) {
        if (input.signal.aborted) throw error;
        const status = statusOf(error);
        // A gateway's own limit applies to every model behind it; switching would only spend more of it.
        const gatewayOwned = viaGateway && Boolean((error as { headers?: { get?: (name: string) => string | null } })?.headers?.get?.("x-free-gateway-error"));
        const switchable = model === FREE_ROUTER && !emitted && !gatewayOwned
          && (status === 403 || status === 404 || status === 429 || (status !== undefined && status >= 500));
        if (switchable && (status === 403 || status === 404)) refused.add(candidate.id);
        if (!switchable || attempt === candidates.length - 1) throw friendly(error, viaGateway);
      }
    }
  }
}

/** Test hook: forget cached catalogs and refusals. */
export function resetFreeAdapterState(): void {
  catalogs.clear();
  refusedModels.clear();
}
