/**
 * The single provider registry, shared by the main process and the renderer.
 * Pure data and pure functions only: no Node, Electron or DOM APIs.
 */

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "mistral",
  "groq",
  "ollama",
  "openai-compatible",
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
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** "Anthropic · claude-sonnet-5" — tolerates an unknown id from a hand-edited settings file. */
export function formatModelLabel({ provider, model }: { provider: ProviderId; model: string }): string {
  return `${PROVIDER_INFO[provider]?.label ?? provider} · ${model}`;
}
