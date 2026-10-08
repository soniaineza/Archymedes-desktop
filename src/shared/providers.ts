/**
 * The single provider registry, shared by the main process and the renderer.
 * Pure data and pure functions only: no Node, Electron or DOM APIs.
 */

/** Same order as the CLI's `provider-specs.ts` PROVIDER_IDS (frontier labs, aggregators, local/generic, free). */
export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "archymedes-cloud",
  "openrouter",
  "google",
  "xai",
  "deepseek",
  "mistral",
  "groq",
  "ollama",
  "openai-compatible",
  "free",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: string;
  /** Endpoint for providers that publish one; undefined lets the SDK use its own default. */
  defaultBaseUrl?: string;
  /** Environment variables that configure this provider when run from a shell. */
  envVars: readonly string[];
  requiresApiKey: boolean;
  /** True when Base URL must be filled in before a request can be sent (no default endpoint). */
  requiresBaseUrl?: boolean;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    defaultModel: "claude-sonnet-5",
    envVars: ["ANTHROPIC_API_KEY"],
    requiresApiKey: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-5.6-terra",
    envVars: ["OPENAI_API_KEY"],
    requiresApiKey: true,
  },
  // The hosted execution exchange: API key = ARCHYMEDES_CLOUD_TOKEN, Base URL = ARCHYMEDES_CLOUD_BASE_URL.
  // `auto` is intentional: the exchange, not this client, selects the concrete model.
  // See src/main/agent/cloud-adapter.ts.
  "archymedes-cloud": {
    id: "archymedes-cloud",
    label: "Archymedes Cloud",
    defaultModel: "auto",
    envVars: ["ARCHYMEDES_CLOUD_TOKEN", "ARCHYMEDES_CLOUD_BASE_URL"],
    requiresApiKey: true,
    requiresBaseUrl: true,
  },
  // OpenRouter with the user's own key and no zero-price cap: any `publisher/model` id, paid or
  // `:free`, and `openrouter/auto` (the gateway picks the model). Unlike `free`, nothing is capped.
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: "openrouter/auto",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    envVars: ["OPENROUTER_API_KEY"],
    requiresApiKey: true,
  },
  google: {
    id: "google",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-pro",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envVars: ["GOOGLE_API_KEY"],
    requiresApiKey: true,
  },
  xai: {
    id: "xai",
    label: "xAI Grok",
    defaultModel: "grok-4",
    defaultBaseUrl: "https://api.x.ai/v1",
    envVars: ["XAI_API_KEY"],
    requiresApiKey: true,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com",
    envVars: ["DEEPSEEK_API_KEY"],
    requiresApiKey: true,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    defaultModel: "mistral-large-latest",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    envVars: ["MISTRAL_API_KEY"],
    requiresApiKey: true,
  },
  groq: {
    id: "groq",
    label: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    envVars: ["GROQ_API_KEY"],
    requiresApiKey: true,
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    defaultModel: "llama3.1",
    defaultBaseUrl: "http://localhost:11434/v1",
    envVars: [],
    requiresApiKey: false,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    defaultModel: "gpt-4o-mini",
    envVars: ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"],
    requiresApiKey: true,
  },
  // No OpenRouter key: requests need a free gateway at Base URL or ARCHYMEDES_FREE_GATEWAY_URL
  // (the hosted public gateway is not generally available yet). An OpenRouter key goes direct.
  // See src/main/agent/free-adapter.ts.
  free: {
    id: "free",
    label: "Free models (OpenRouter)",
    defaultModel: "openrouter/free",
    envVars: [],
    requiresApiKey: false,
  },
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** "Anthropic · claude-sonnet-5" — tolerates an unknown id from a hand-edited settings file. */
export function formatModelLabel({ provider, model }: { provider: ProviderId; model: string }): string {
  return `${PROVIDER_INFO[provider]?.label ?? provider} · ${model}`;
}
