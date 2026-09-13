/**
 * Port of the CLI's provider selection logic (providers/agent-matrix.ts).
 * Provider identity lives in the shared registry; this module only adds the
 * parts that read the process environment, which the renderer must not import.
 */

import { isProviderId, PROVIDER_IDS, PROVIDER_INFO } from "../../shared/providers";
import type { ProviderId, ProviderInfo } from "../../shared/providers";
import { catalogPricesOf } from "./price-lookup";
import type { TokenPrices } from "./money";

export { isProviderId, PROVIDER_IDS, PROVIDER_INFO };
export type { ProviderId, ProviderInfo };

export type ProviderStatus = {
  info: ProviderInfo;
  configured: boolean;
  /** Missing environment variables, when configured is false because of them. */
  missing: string[];
};

export function describeProviders(environment: Record<string, string | undefined> = process.env): ProviderStatus[] {
  return PROVIDER_IDS.map((id) => {
    const info = PROVIDER_INFO[id];
    const missing = info.envVars.filter((key) => !environment[key]?.trim());
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
  const statuses = describeProviders(environment);
  return statuses.find((s) => s.configured)?.info.id;
}

/** Which wire protocol a provider speaks. Everything but Anthropic is OpenAI-compatible. */
export function wireProtocol(id: ProviderId): "anthropic" | "openai-compatible" {
  return id === "anthropic" ? "anthropic" : "openai-compatible";
}

export function catalogPrices(provider: ProviderId, model: string, asOf?: string): TokenPrices | undefined {
  return catalogPricesOf(provider, model, asOf);
}
