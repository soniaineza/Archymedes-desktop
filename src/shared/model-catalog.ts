/**
 * The parts of model listing that touch nothing but data, shared by the main process and the
 * renderer. Port of the CLI's `core/src/providers/model-list.ts` (endpoint, auth, parse and merge
 * rules) plus the id rules of `free-catalog.ts`. The CLI reads keys and base URLs from environment
 * variables; the desktop reads them from Settings, so `modelsEndpoint` takes those two values.
 *
 * Pure data and pure functions only: no Node, Electron or DOM APIs.
 */

import type { ProviderId } from "./providers";

export const FREE_ROUTER = "openrouter/free";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Where a free OpenRouter key is created. */
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
/** OpenRouter's privacy settings: free models need their free-endpoint options enabled there. */
export const OPENROUTER_PRIVACY_URL = "https://openrouter.ai/settings/privacy";
/** Where credits are bought (a negative balance blocks even free models with HTTP 402). */
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/settings/credits";

/** `openrouter/free`, or an exact `publisher/model:free` id. */
export function isFreeModelId(id: string): boolean {
  return id === FREE_ROUTER || (id.length <= 256 && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(id));
}

/** Per-million token prices in micros of `currency`, as the price catalog records them. */
export interface ModelPrice {
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

/** One entry of the model picker. */
export interface ModelChoice {
  id: string;
  /** The model this provider uses when none is named. */
  isDefault: boolean;
  /** Undefined when the catalog has no rate: shown as "unpriced", never guessed. */
  price?: ModelPrice;
  /** True for a model the provider reported that this build's catalog does not know. */
  live?: boolean;
}

/**
 * - `ok`: the live list was read (or served from a fresh cache).
 * - `no-key`: the provider needs a key (or a Base URL) before it can be asked.
 * - `unsupported`: the provider publishes no list to ask (Archymedes Cloud routes `auto` itself).
 * - `error`: the request failed; `error` says why, and `live` may hold an older cached list.
 */
export type ModelListStatus = "ok" | "no-key" | "unsupported" | "error";

export interface ModelListRequest {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  /** Skip the 6h cache and ask the provider again. */
  refresh?: boolean;
}

export interface ModelListing {
  provider: ProviderId;
  /** What this build knows, as the CLI's `modelsForProvider` lists it: the default first. */
  known: ModelChoice[];
  /** What the provider reported beyond `known`, sorted. */
  live: ModelChoice[];
  status: ModelListStatus;
  /** A short reason when `status` is "error". Never contains a credential. */
  error?: string;
  /** Epoch millis the live list was fetched. */
  fetchedAt?: number;
}

/**
 * Joins a base URL to the models path without doubling the version segment: gateways are
 * conventionally configured with `/v1` included, and `/v1/v1/models` 404s like an outage.
 */
export function modelsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

/** Default hosts the CLI's `modelsEndpoint` uses when no base URL override is set. */
const DEFAULT_LIST_BASES: Partial<Record<ProviderId, string>> = {
  openrouter: OPENROUTER_BASE_URL,
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
};

/** Whether a provider has a `/v1/models` list worth asking at all. */
export function supportsLiveListing(provider: ProviderId): boolean {
  // The routed model is intentionally `auto`; a cloud-wide inventory would bypass the account
  // policy that decides what is usable (same rule as the CLI).
  return provider !== "archymedes-cloud";
}

/**
 * Where a provider's list lives, and how the key is presented. All of them speak
 * `GET /v1/models` → `{ data: [{ id }] }`, but Anthropic authenticates with `x-api-key` and
 * requires a version header, while everyone else takes a Bearer token. Undefined when the provider
 * cannot be asked (no key, no base URL, or no list). Free mode is handled by its own catalog.
 */
export function modelsEndpoint(
  provider: ProviderId,
  settings: { apiKey: string; baseUrl: string },
): { url: string; headers: Record<string, string> } | undefined {
  const key = settings.apiKey.trim() || undefined;
  const base = settings.baseUrl.trim() || DEFAULT_LIST_BASES[provider];
  switch (provider) {
    case "free":
    case "archymedes-cloud":
      return undefined;
    case "anthropic":
      if (!key || !base) return undefined;
      return { url: `${modelsUrl(base)}?limit=1000`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
    case "ollama":
      // Nothing to authenticate, and locally pulled models are exactly what no catalog can list.
      return base ? { url: modelsUrl(base), headers: {} } : undefined;
    case "openrouter":
    case "openai":
    case "google":
    case "xai":
    case "deepseek":
    case "mistral":
    case "groq":
    case "openai-compatible":
      if (!key || !base) return undefined;
      return { url: modelsUrl(base), headers: { authorization: `Bearer ${key}` } };
  }
}

/**
 * Model ids out of a `/v1/models` body. Tolerant by design: `{data:[…]}`, `{models:[…]}` or a bare
 * array, with string entries or objects carrying `id` or `name`.
 */
export function parseModelsResponse(body: unknown): string[] {
  const entries = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown })?.models)
        ? (body as { models: unknown[] }).models
        : [];

  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      ids.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as { id?: unknown; name?: unknown };
      const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined;
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/** Models that cannot hold a conversation, matched on the id (all `/v1/models` reliably returns). */
const NON_CHAT = [
  /embed/i, /moderation/i, /whisper/i, /^tts/i, /audio/i, /dall-?e/i, /^stable-/i,
  /image/i, /vision-encoder/i, /rerank/i, /guard/i, /^text-similarity/i, /^text-search/i,
  /transcribe/i, /realtime/i, /^omni-moderation/i, /^davinci/i, /^babbage/i, /codex-mini/i,
];

export function isConversationalModel(id: string): boolean {
  return !NON_CHAT.some((pattern) => pattern.test(id));
}

/**
 * Folds a live list into the known one: known models keep their order (default first), new ones
 * are appended sorted, so the list a user has learned does not reshuffle.
 */
export function mergeModelLists(known: readonly string[], live: readonly string[] | undefined): string[] {
  if (!live || live.length === 0) return [...known];
  const seen = new Set(known);
  const added = live.filter((model) => !seen.has(model)).sort();
  return [...known, ...added];
}

/**
 * The picker's filter: exact id, then prefix, then substring (case-insensitive), and within a tier
 * the original order. Same tiers as the CLI's `matchModelQuery`, so the most precise thing typed
 * ranks first rather than being buried among the ids it is a prefix of.
 */
export function filterModelChoices<T extends { id: string }>(choices: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...choices];
  const tiers: T[][] = [[], [], []];
  for (const choice of choices) {
    const id = choice.id.toLowerCase();
    if (id === needle) tiers[0].push(choice);
    else if (id.startsWith(needle)) tiers[1].push(choice);
    else if (id.includes(needle)) tiers[2].push(choice);
  }
  return tiers.flat();
}
