/**
 * Port of the CLI's provider identity (providers/provider-specs.ts) and
 * selection logic (providers/agent-matrix.ts): what each provider *is*,
 * separated from what it takes to talk to one.
 */

import { catalogPricesOf } from "./price-lookup";
import type { TokenPrices } from "./money";

export type ProviderId =
  | "anthropic" | "openai" | "google" | "xai" | "deepseek"
  | "mistral" | "groq" | "ollama" | "openai-compatible";

export const PROVIDER_IDS: readonly ProviderId[] = [
  "anthropic", "openai", "google", "xai", "deepseek", "mistral", "groq", "ollama", "openai-compatible",
];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  /** Environment variables that must be set for this provider to be usable. */
  requires: readonly string[];
  defaultModel: string;
};

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  anthropic: { id: "anthropic", label: "Anthropic", requires: ["ANTHROPIC_API_KEY"], defaultModel: "claude-sonnet-5" },
  openai: { id: "openai", label: "OpenAI", requires: ["OPENAI_API_KEY"], defaultModel: "gpt-5.6-terra" },
  google: { id: "google", label: "Google Gemini", requires: ["GOOGLE_API_KEY"], defaultModel: "gemini-2.5-pro" },
  xai: { id: "xai", label: "xAI Grok", requires: ["XAI_API_KEY"], defaultModel: "grok-4" },
  deepseek: { id: "deepseek", label: "DeepSeek", requires: ["DEEPSEEK_API_KEY"], defaultModel: "deepseek-chat" },
  mistral: { id: "mistral", label: "Mistral", requires: ["MISTRAL_API_KEY"], defaultModel: "mistral-large-latest" },
  groq: { id: "groq", label: "Groq", requires: ["GROQ_API_KEY"], defaultModel: "llama-3.3-70b-versatile" },
  ollama: { id: "ollama", label: "Ollama (local)", requires: [], defaultModel: "llama3.1" },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    requires: ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"],
    defaultModel: "gpt-4o-mini",
  },
};

export type ProviderStatus = {
  info: ProviderInfo;
  configured: boolean;
  /** Missing environment variables, when configured is false because of them. */
  missing: string[];
};

export function describeProviders(environment: Record<string, string | undefined> = process.env): ProviderStatus[] {
  return PROVIDER_IDS.map((id) => {
    const info = PROVIDER_INFO[id];
    const missing = info.requires.filter((key) => !environment[key]?.trim());
    return { info, configured: missing.length === 0, missing };
  });
}

/**
 * Which provider to use for a session: the explicit choice, else the first
 * configured provider in catalog order (frontier labs before aggregators,
 * local/generic escape hatches last).
 */
export function resolveProvider(
  environment: Record<string, string | undefined> = process.env,
  explicit?: string,
): ProviderId | undefined {
  if (explicit && isProviderId(explicit)) return explicit;
  return PROVIDER_IDS.find((id) => describeProviders(environment).find((s) => s.info.id === id)?.configured);
}

/** Which wire protocol a provider speaks. Everything but Anthropic is OpenAI-compatible. */
export function wireProtocol(id: ProviderId): "anthropic" | "openai-compatible" {
  return id === "anthropic" ? "anthropic" : "openai-compatible";
}

/** Default base URL for providers that publish one; undefined lets the SDK default. */
export function defaultBaseUrl(id: ProviderId): string | undefined {
  switch (id) {
    case "google": return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "xai": return "https://api.x.ai/v1";
    case "deepseek": return "https://api.deepseek.com";
    case "mistral": return "https://api.mistral.ai/v1";
    case "groq": return "https://api.groq.com/openai/v1";
    case "ollama": return "http://localhost:11434/v1";
    default: return undefined;
  }
}

export function catalogPrices(provider: ProviderId, model: string, asOf?: string): TokenPrices | undefined {
  return catalogPricesOf(provider, model, asOf);
}
