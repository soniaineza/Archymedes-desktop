/**
 * Port of the CLI's dated price catalog (providers/price-catalog.ts).
 * Rates recorded in the provider's own currency and denominator, each with a
 * verified-on date; unknown models report "unpriced" rather than guessing.
 */

import { definePrices, type PriceRecord } from "./pricing";

function tokens(provider: string, model: string, currency: string, input: number, output: number, cachedInput: number | undefined, source: string, effectiveFrom: string): PriceRecord {
  return {
    provider, model, modality: "text", currency, billingUnit: "tokens", per: 1_000_000,
    rates: { input, output, ...(cachedInput === undefined ? {} : { cachedInput }) },
    source, effectiveFrom,
  };
}

const ANTHROPIC_VERIFIED = "2026-06-24";
const ANTHROPIC_SOURCE = "anthropic.com/pricing, recorded 2026-06-24";

const ANTHROPIC: PriceRecord[] = [
  ...["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"].map((model) => tokens("anthropic", model, "USD", 5, 25, 0.5, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED)),
  tokens("anthropic", "claude-fable-5", "USD", 10, 50, 1, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),
  tokens("anthropic", "claude-sonnet-4-6", "USD", 3, 15, 0.3, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),
  tokens("anthropic", "claude-haiku-4-5", "USD", 1, 5, 0.1, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED),
  // Sonnet 5's introductory rate ended 2026-08-31; both rates are true, on different days.
  { ...tokens("anthropic", "claude-sonnet-5", "USD", 2, 10, 0.2, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED), effectiveUntil: "2026-09-01", source: `${ANTHROPIC_SOURCE} (introductory rate through 2026-08-31)` },
  { ...tokens("anthropic", "claude-sonnet-5", "USD", 3, 15, 0.3, ANTHROPIC_SOURCE, ANTHROPIC_VERIFIED), effectiveFrom: "2026-09-01", source: `${ANTHROPIC_SOURCE} (standard rate from 2026-09-01)` },
];

const OAI_COMPAT_SOURCE = "each provider's public pricing page — indicative defaults, recorded 2026-06-01";
const OAI_COMPAT_VERIFIED = "2026-06-01";

const OAI_COMPAT_LABS: PriceRecord[] = [
  { ...tokens("google", "gemini-2.5-pro", "USD", 1.25, 10, 0.31, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED), largeContext: { aboveInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  tokens("google", "gemini-2.5-flash", "USD", 0.3, 2.5, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  { ...tokens("xai", "grok-4", "USD", 3, 15, 0.75, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED), largeContext: { aboveInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 2 } },
  tokens("xai", "grok-4-fast", "USD", 0.2, 0.5, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("deepseek", "deepseek-chat", "USD", 0.28, 0.42, 0.028, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("deepseek", "deepseek-reasoner", "USD", 0.28, 2.19, 0.028, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("mistral", "mistral-large-latest", "USD", 2, 6, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("mistral", "mistral-small-latest", "USD", 0.2, 0.6, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
  tokens("groq", "llama-3.3-70b-versatile", "USD", 0.59, 0.79, undefined, OAI_COMPAT_SOURCE, OAI_COMPAT_VERIFIED),
];

export const PRICE_CATALOG: readonly PriceRecord[] = definePrices([...ANTHROPIC, ...OAI_COMPAT_LABS]);

/** Providers this build deliberately ships no rates for: report "unpriced", never a guess. */
export const UNPRICED_PROVIDERS: readonly string[] = ["openai", "openai-compatible"];
