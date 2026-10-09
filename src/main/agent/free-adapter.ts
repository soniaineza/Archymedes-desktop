/**
 * Free mode for the desktop app, ported from the CLI's `free-agent.ts`. With the user's own
 * OpenRouter key requests go only to OpenRouter; without one they go to the Archymedes free gateway,
 * which holds a key server-side. Either way only verified zero-priced tool models are used, every
 * request carries a zero price cap with fallbacks off, and nothing ever falls back to a paid model.
 */
import type { ProviderSettings } from "../../shared/types";
import { AppError } from "../../shared/app-error";
import type { AppErrorCode, AppErrorParams } from "../../shared/app-error";
import { ModelHealthStore, userDataHealthFile } from "./model-health";
import type { AdapterEvent, AgentAdapter, RuntimeTurn, ToolSchema } from "./adapter";
import { StreamTimeoutError } from "./stream-deadline";
import { fileFreeInstallStore, FREE_INSTALL_HEADER, FREE_INSTALL_STATUS_HEADER, FreeInstallToken, userDataInstallFile } from "./free-install";
import type { StreamDeadlineOptions } from "./stream-deadline";
import { FREE_ROUTER, isFreeModelId, OPENROUTER_BASE_URL, OPENROUTER_PRIVACY_URL } from "../../shared/model-catalog";

// One definition, shared with the model picker (src/shared/model-catalog.ts).
export { FREE_ROUTER, isFreeModelId, OPENROUTER_BASE_URL };
/**
 * The official hosted free gateway (mirrors the CLI's `FREE_GATEWAY_URL`).
 * TODO: set this once the public gateway is deployed. Until then free mode without an OpenRouter key
 * needs ARCHYMEDES_FREE_GATEWAY_URL or a gateway URL in Settings -> Base URL.
 */
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
/**
 * How long a fetched eligibility listing is reused. One hour, matching the CLI's
 * `FREE_CATALOG_TTL_MS` and the free gateway's own hourly refresh — a client cache staler than its
 * source would offer models that have since stopped qualifying. The two ports held different values
 * (6h here's counterpart, 1h here) until they were reconciled; keep them equal.
 *
 * A freshness budget, never a safety one: the zero price cap and `allow_fallbacks: false` are
 * re-asserted on every request, so a stale entry costs a wasted attempt and never a charge.
 */
const CATALOG_TTL_MS = 60 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 8_192;
/** A free model that has not started streaming by then is skipped for the next candidate. */
export const FREE_FIRST_BYTE_MS = 45_000;
const CATALOG_TIMEOUT_MS = 15_000;

export type FreeModel = { id: string; contextWindow: number; maxOutput: number | null };
export type FreeEndpoint = { baseUrl: string; apiKey?: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

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
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  const response = await fetchImpl(`${baseUrl}/models`, { signal: combined, redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = parseFreeModels(await response.json());
  catalogs.set(baseUrl, { at: now, models });
  return models;
}

/** Install tokens per gateway, shared by every run this app session. */
const installs = new Map<string, FreeInstallToken>();

/** Response headers as a Fetch `Headers` object, or the plain lower-cased record openai v4 puts on `APIError.headers`. */
type HeaderBag = { get?: (name: string) => string | null } | Record<string, string | null | undefined> | undefined;

function headerOf(headers: HeaderBag, name: string): string | null {
  if (!headers) return null;
  if (typeof headers.get === "function") return (headers.get as (key: string) => string | null)(name);
  const value = (headers as Record<string, unknown>)[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

/** Gateway failure types that mean "this model failed, another may not" (free-gateway README). */
const RETRYABLE_UPSTREAM_TYPES = new Set(["upstream_timeout", "upstream_idle_timeout", "upstream_unreachable", "upstream_stream_failed"]);

/**
 * The HTTP status of a failure, including the gateway's in-stream error event. A stalled or broken
 * upstream stream ends with `data: {"error":{"code":504|502,"type":"upstream_...","retryable":true}}`;
 * the OpenAI SDK raises that as an `APIError` with no `status` but with the event's `error` object,
 * so the code is read from there.
 */
export function freeFailureStatus(error: unknown): number | undefined {
  const record = error as { status?: unknown; error?: unknown } | undefined;
  if (typeof record?.status === "number") return record.status;
  const body = (record?.error && typeof record.error === "object" ? record.error : record) as { code?: unknown; type?: unknown; retryable?: unknown } | undefined;
  if (!body || !(body.retryable === true || (typeof body.type === "string" && RETRYABLE_UPSTREAM_TYPES.has(body.type)))) return undefined;
  const code = typeof body.code === "number" ? body.code : Number(body.code);
  return Number.isInteger(code) && code >= 500 && code < 600 ? code : 502;
}

function statusOf(error: unknown): number | undefined {
  return freeFailureStatus(error);
}

/** No HTTP response at all (DNS, refused, reset, TLS): a network fault, not a server error. */
function isTransportFailure(error: unknown): boolean {
  if (statusOf(error) !== undefined || error instanceof StreamTimeoutError) return false;
  const names = [(error as { constructor?: { name?: unknown } })?.constructor?.name, (error as { name?: unknown })?.name];
  return names.some((name) => name === "APIConnectionError" || name === "APIConnectionTimeoutError")
    || error instanceof TypeError || Boolean((error as { cause?: unknown })?.cause);
}

function countHeader(headers: HeaderBag, name: string): number | undefined {
  const raw = headerOf(headers, name);
  const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export type GatewayAllowance = { remainingTokens?: number; remainingRequests?: number; resetUtc?: string; warning?: string };

/**
 * The gateway's daily-allowance headers (`x-free-remaining-tokens`, `x-free-remaining-requests`, both
 * describing the state before the request), or null when the response carried neither (e.g. a
 * user's own key, or an older gateway).
 */
export function allowanceOf(headers: HeaderBag): GatewayAllowance | null {
  const remainingTokens = countHeader(headers, "x-free-remaining-tokens");
  const remainingRequests = countHeader(headers, "x-free-remaining-requests");
  if (remainingTokens === undefined && remainingRequests === undefined) return null;
  const resetUtc = headerOf(headers, "x-free-reset-utc") ?? undefined;
  const warning = headerOf(headers, "x-free-allowance-warning") ?? undefined;
  return {
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(resetUtc ? { resetUtc } : {}),
    ...(warning ? { warning } : {}),
  };
}

/** The error object a failure carries (OpenAI SDK `APIError.error`, or the body itself). */
function errorBody(error: unknown): Record<string, unknown> {
  const record = error as { error?: unknown } | undefined;
  const body = record?.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : {};
  // Some hosts nest it once more: {error: {error: {...}}}.
  return body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : body;
}

function messagesOf(error: unknown): string {
  const body = errorBody(error);
  const metadata = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
  return [
    error instanceof Error ? error.message : "",
    typeof body.message === "string" ? body.message : "",
    typeof metadata.raw === "string" ? metadata.raw : "",
  ].join("\n");
}

export type LimitKind = "per_minute" | "daily_requests" | "daily_tokens";

/**
 * Which limit a 429 hit: the gateway's JSON body names it (`kind`), OpenRouter's own free-model
 * limits name it in the message (`free-models-per-min` / `free-models-per-day`). Undefined when
 * nothing says (e.g. an upstream provider's own rate limit).
 */
export function limitOf(error: unknown): { kind: LimitKind; resetUtc?: string; retryAfterSeconds?: number } | undefined {
  const body = errorBody(error);
  const headers = (error as { headers?: HeaderBag } | undefined)?.headers;
  const retryHeader = countHeader(headers, "retry-after");
  const retryBody = typeof body.retry_after_seconds === "number" && body.retry_after_seconds >= 0 ? Math.ceil(body.retry_after_seconds) : undefined;
  const retryAfterSeconds = retryBody ?? retryHeader;
  const resetBody = typeof body.reset_utc === "string" && Number.isFinite(Date.parse(body.reset_utc)) ? body.reset_utc : undefined;
  const resetHeader = headerOf(headers, "x-free-reset-utc") ?? undefined;
  // OpenRouter's platform 429s carry X-RateLimit-Reset in epoch milliseconds.
  const rateReset = countHeader(headers, "x-ratelimit-reset");
  const resetOpenRouter = rateReset !== undefined && rateReset > 1e12 ? new Date(rateReset).toISOString() : undefined;
  const resetUtc = resetBody ?? (resetHeader && Number.isFinite(Date.parse(resetHeader)) ? resetHeader : undefined) ?? resetOpenRouter;
  const extra = { ...(resetUtc ? { resetUtc } : {}), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
  if (body.kind === "per_minute" || body.kind === "daily_requests" || body.kind === "daily_tokens") return { kind: body.kind, ...extra };
  const text = messagesOf(error);
  if (/free-models-per-min|per[- ]minute/i.test(text)) return { kind: "per_minute", ...extra };
  if (/free-models-per-day|per[- ]day|daily|today/i.test(text)) return { kind: "daily_requests", ...extra };
  return undefined;
}

/** OpenRouter refuses free models whose providers the account's privacy settings exclude. */
export function isDataPolicyError(error: unknown): boolean {
  return /data policy|privacy settings|settings\/privacy|model training/i.test(messagesOf(error));
}

/** An OpenRouter platform limit (not one model's provider): switching models would only spend more of it. */
function isAccountLimit(error: unknown): boolean {
  return /free-models-per-(?:day|min)/i.test(messagesOf(error)) || countHeader((error as { headers?: HeaderBag })?.headers, "x-ratelimit-remaining") !== undefined;
}

/** "HH:MM" in UTC, for messages that say when a daily limit resets. */
function utcClock(iso: string | undefined): string | undefined {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString().slice(11, 16) : undefined;
}

/**
 * The gateway's own refusal text: it names which limit fired and when it resets, which the generic
 * message cannot. Only trusted when the failure is gateway-owned (`x-free-gateway-error`).
 */
export function gatewayMessageOf(error: unknown): string | undefined {
  const record = error as { headers?: HeaderBag; error?: unknown } | undefined;
  if (!headerOf(record?.headers, "x-free-gateway-error")) return undefined;
  const body = record?.error && typeof record.error === "object" ? (record.error as { message?: unknown }) : undefined;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return undefined;
  // The gateway words its hint for the CLI; the desktop sets the key in Settings.
  return message.replace(/Type \/upgrade to use your own OpenRouter API key\.?/, "Add your own OpenRouter API key in Settings to keep going.").slice(0, 500);
}

function coded(code: AppErrorCode, message: string, params: AppErrorParams | undefined, status: number | undefined, cause: unknown): AppError {
  return Object.assign(new AppError(code, message, params), { status, cause });
}

/**
 * A failure as something the user can act on. Known cases carry an AppError code (the renderer
 * shows a translated message and the right button); the English message stays for logs and tests.
 */
export function friendly(error: unknown, viaGateway: boolean): Error {
  const status = statusOf(error);
  const gatewayMessage = viaGateway && status === 429 ? gatewayMessageOf(error) : undefined;
  if (status === 429) {
    const limit = limitOf(error);
    if (limit?.kind === "per_minute") {
      const seconds = limit.retryAfterSeconds ?? 60;
      const message = gatewayMessage ?? `Free-model rate limit reached (requests per minute). Wait ${seconds} seconds and retry.`;
      return coded("free-rate-minute", message, { seconds }, status, error);
    }
    if (limit) {
      const time = utcClock(limit.resetUtc) ?? "00:00";
      const message = gatewayMessage ?? (viaGateway
        ? `Today's free allowance is used up. It resets at ${time} UTC; add your own OpenRouter API key in Settings to keep going.`
        : `Today's free-model requests for this OpenRouter key are used up. They reset at ${time} UTC; buying 10 credits raises the limit to 1000 a day.`);
      return coded("free-daily-limit", message, { time }, status, error);
    }
  }
  if (gatewayMessage) return Object.assign(new Error(gatewayMessage), { status, cause: error });
  if (isTransportFailure(error)) {
    const message = viaGateway
      ? "Could not reach the free gateway. Check your connection and retry, or add your own OpenRouter API key. No paid fallback was attempted."
      : "Could not reach OpenRouter. Check your connection and retry. No paid fallback was attempted.";
    return Object.assign(new Error(message), { cause: error });
  }
  if (!viaGateway && (status === 404 || status === 403 || status === 400) && isDataPolicyError(error)) {
    return coded("free-data-policy", `No free model endpoint matches your OpenRouter privacy settings. Free models need their free-endpoint options enabled at ${OPENROUTER_PRIVACY_URL}.`, undefined, status, error);
  }
  if (!viaGateway && status === 401) return coded("free-bad-key", "OpenRouter rejected the API key. Check the key in Settings.", undefined, status, error);
  if (status === 402) {
    return coded("free-credits", "OpenRouter refused the request for lack of credits (HTTP 402): the key's budget is used up or the account balance is negative.", undefined, status, error);
  }
  if (!viaGateway && (status === 404 || status === 503 || status === 403)) {
    return coded("free-model-unavailable", "This free model is unavailable right now. Choose openrouter/free or another free model in Settings.", undefined, status, error);
  }
  const message = viaGateway
    ? status === 429 ? "Free gateway limit reached. Wait before retrying, or add your own OpenRouter API key."
      : status === 413 ? "The conversation is too large for the free gateway. Start a new session."
      : "The free gateway could not complete the request. Try again later, or add your own OpenRouter API key. No paid fallback was attempted."
    : status === 429 ? "OpenRouter free-model rate limit reached. Wait before retrying."
      : "Free model request failed. No paid fallback was attempted.";
  return Object.assign(new Error(message), { status, cause: error });
}

/**
 * Per-attempt request tuning handed to the inner OpenAI-compatible adapter. `headers` are extra request
 * headers (the gateway install token); `onResponseHeaders` should be called with the response headers
 * so the token's status (`x-archymedes-install-status`) can be checked.
 */
export type FreeTuning = {
  deadline: Partial<StreamDeadlineOptions>;
  maxRetries: number;
  headers?: Record<string, string>;
  onResponseHeaders?: (headers: HeaderBag) => void;
};

function installFor(gateway: string, fetchImpl: Fetch | undefined): FreeInstallToken {
  let install = installs.get(gateway);
  if (!install) {
    install = new FreeInstallToken({
      gatewayUrl: gateway,
      store: fileFreeInstallStore(userDataInstallFile),
      ...(fetchImpl ? { fetchImpl: fetchImpl as never } : {}),
    });
    installs.set(gateway, install);
  }
  return install;
}

export class FreeAdapter implements AgentAdapter {
  readonly name = "free";

  constructor(
    private readonly settings: ProviderSettings,
    /** `inner` streams one attempt; `adapters.ts` passes its OpenAI-compatible adapter, which keeps this module free of an import cycle. */
    private readonly dependencies: {
      inner: (settings: ProviderSettings, extraBody: Record<string, unknown>, tuning: FreeTuning) => AgentAdapter;
      fetchImpl?: Fetch;
      /** Gateway install-token source; defaults to one per gateway stored in userData. `null` disables it. */
      install?: FreeInstallToken | null;
      now?: () => number;
      environment?: Record<string, string | undefined>;
      /** Per-model success history that orders openrouter/free candidates; defaults to one in userData. `null` disables it. */
      health?: ModelHealthStore | null;
    },
  ) {}

  async runTurn(input: { systemPrompt: string; turns: RuntimeTurn[]; tools: ToolSchema[]; onEvent: (event: AdapterEvent) => void; signal: AbortSignal }): Promise<void> {
    const endpoint = freeEndpoint(this.settings, this.dependencies.environment);
    if (!endpoint) {
      throw new AppError(
        "free-unavailable",
        "Free mode isn't available in this build yet: no free gateway is configured. Set a free gateway URL in Settings (Base URL), or pick another provider.",
      );
    }
    const model = this.settings.model.trim() || FREE_ROUTER;
    if (!isFreeModelId(model)) throw new Error("Free mode accepts openrouter/free or an exact publisher/model:free ID. Paid models are not allowed.");
    const viaGateway = !endpoint.apiKey;
    // The install token is only for the gateway; a user's own key never triggers issuance.
    const install = !viaGateway
      ? undefined
      : this.dependencies.install === undefined
        ? installFor(endpoint.baseUrl.replace(/\/v1$/, ""), this.dependencies.fetchImpl)
        : (this.dependencies.install ?? undefined);
    // Fetched alongside the catalog check; never throws and never waits more than a few seconds.
    const installing = install?.get(input.signal);

    let eligible: FreeModel[];
    try {
      eligible = await loadCatalog(endpoint.baseUrl, this.dependencies.fetchImpl ?? fetch, input.signal, (this.dependencies.now ?? Date.now)());
    } catch (error) {
      if (input.signal.aborted) throw error;
      throw new Error("Could not verify the free model list. Check your connection and retry; no request was sent.");
    }
    const refused = refusedModels.get(endpoint.baseUrl) ?? new Set<string>();
    refusedModels.set(endpoint.baseUrl, refused);
    const health = this.dependencies.health === undefined ? defaultHealth() : (this.dependencies.health ?? undefined);
    const ordered = orderCandidates(model, eligible, refused);
    // Models that answered recently go first; ones that failed sink but are never dropped for good.
    const ranked = health && model === FREE_ROUTER ? await health.rank(ordered).catch(() => ordered) : ordered;
    const candidates = ranked.slice(0, MAX_ATTEMPTS);
    if (candidates.length === 0) throw new Error("No eligible free tool model is available right now. Try again later.");
    await installing;

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
      // Read per attempt: a token an earlier attempt had rejected is not sent again.
      const token = install?.current();
      // Success and error responses alike carry the install-token status and the allowance headers.
      const observe = (headers: HeaderBag): void => {
        install?.observe(headerOf(headers, FREE_INSTALL_STATUS_HEADER), token);
        const allowance = viaGateway ? allowanceOf(headers) : null;
        if (allowance) input.onEvent({ type: "allowance", ...allowance });
      };
      try {
        // The SDK retries nothing here: this loop is the retry, on the next candidate, and fast.
        const tuning: FreeTuning = {
          deadline: { firstByteMs: FREE_FIRST_BYTE_MS },
          maxRetries: model === FREE_ROUTER ? 0 : 1,
          ...(token ? { headers: { [FREE_INSTALL_HEADER]: token } } : {}),
          ...(viaGateway ? { onResponseHeaders: observe } : {}),
        };
        await inner({ ...this.settings, apiKey: endpoint.apiKey ?? "archymedes-free-gateway", baseUrl: endpoint.baseUrl, model: candidate.id }, extraBody, tuning).runTurn({ ...input, onEvent });
        void health?.recordSuccess(candidate.id).catch(() => undefined);
        return;
      } catch (error) {
        observe((error as { headers?: HeaderBag })?.headers);
        if (input.signal.aborted) throw error;
        // Includes the gateway's retryable in-stream error event (504/502), which has no HTTP status.
        const status = statusOf(error);
        // A model that never started answering is skipped like an unavailable one.
        const stalled = error instanceof StreamTimeoutError && !emitted;
        // A gateway's own limit applies to every model behind it, and so do OpenRouter's account-wide
        // free-model limits and privacy settings; none of them says anything about this model.
        const gatewayOwned = viaGateway && Boolean(headerOf((error as { headers?: HeaderBag })?.headers, "x-free-gateway-error"));
        const accountWide = gatewayOwned || (status === 429 && isAccountLimit(error)) || isDataPolicyError(error) || status === 401 || status === 402;
        if (!accountWide && (stalled || status === 403 || status === 404 || status === 429 || (status !== undefined && status >= 500))) {
          void health?.recordFailure(candidate.id, stalled ? "no response" : `HTTP ${status}`).catch(() => undefined);
        }
        if (stalled && model === FREE_ROUTER && attempt < candidates.length - 1) {
          input.onEvent({ type: "retry", reason: `${candidate.id} did not respond; trying another free model.` });
          continue;
        }
        if (error instanceof StreamTimeoutError) throw error;
        // Switching models past an account-wide limit would only spend more of it.
        const switchable = model === FREE_ROUTER && !emitted && !gatewayOwned && !(status === 429 && isAccountLimit(error))
          && (status === 403 || status === 404 || status === 429 || (status !== undefined && status >= 500));
        if (switchable && (status === 403 || status === 404)) refused.add(candidate.id);
        if (!switchable || attempt === candidates.length - 1) throw friendly(error, viaGateway);
        input.onEvent({ type: "retry", reason: `${candidate.id} is unavailable; trying another free model.` });
      }
    }
  }
}

let sharedHealth: ModelHealthStore | null = null;
function defaultHealth(): ModelHealthStore {
  sharedHealth ??= new ModelHealthStore(userDataHealthFile);
  return sharedHealth;
}

/** Test hook: forget cached catalogs, refusals and the in-memory model health. */
export function resetFreeAdapterState(): void {
  catalogs.clear();
  refusedModels.clear();
  installs.clear();
  sharedHealth = null;
}
