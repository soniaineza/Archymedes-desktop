/**
 * Port of the CLI's model-capabilities table (providers/model-capabilities.ts):
 * what each known model can hold and produce, with longest-prefix matching and
 * a conservative default for anything unrecognised.
 */

export type ModelCapabilities = {
  contextWindow: number;
  maxOutputTokens: number;
  supportsEffort: boolean;
};

export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = { contextWindow: 200_000, maxOutputTokens: 16_000, supportsEffort: false };

type CapabilityEntry = { prefix: string; match: "prefix" | "exact"; capabilities: ModelCapabilities };

function exactCapabilities(models: readonly string[], contextWindow: number, maxOutputTokens: number, supportsEffort = false): CapabilityEntry[] {
  return models.map((prefix) => ({ prefix, match: "exact", capabilities: { contextWindow, maxOutputTokens, supportsEffort } }));
}

const KNOWN_CAPABILITIES: ReadonlyArray<CapabilityEntry> = [
  // Free mode's router: conservative until a concrete free model is chosen per request.
  ...exactCapabilities(["openrouter/free"], 32_768, 4_096),
  { prefix: "gemini-2.5-pro", match: "prefix", capabilities: { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsEffort: true } },
  { prefix: "gemini-2.5-flash", match: "prefix", capabilities: { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsEffort: true } },
  { prefix: "gemini", match: "prefix", capabilities: { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsEffort: false } },
  { prefix: "grok-4", match: "prefix", capabilities: { contextWindow: 256_000, maxOutputTokens: 64_000, supportsEffort: false } },
  { prefix: "grok", match: "prefix", capabilities: { contextWindow: 131_072, maxOutputTokens: 32_768, supportsEffort: false } },
  ...exactCapabilities(["deepseek-chat", "deepseek-reasoner"], 131_072, 65_536),
  ...exactCapabilities(["mistral-large-latest", "mistral-small-latest"], 131_072, 32_768),
  ...exactCapabilities(["llama-3.3-70b-versatile"], 131_072, 32_768),

  { prefix: "claude-fable-5", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-5", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-4-8", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-4-7", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-opus-4-6", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-sonnet-5", match: "prefix", capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } },
  { prefix: "claude-sonnet-4-6", match: "prefix", capabilities: { contextWindow: 200_000, maxOutputTokens: 64_000, supportsEffort: true } },
  { prefix: "claude-sonnet-4-5", match: "prefix", capabilities: { contextWindow: 200_000, maxOutputTokens: 64_000, supportsEffort: true } },
  { prefix: "claude-haiku-4-5", match: "prefix", capabilities: { contextWindow: 200_000, maxOutputTokens: 64_000, supportsEffort: false } },

  // OpenAI rows match exactly on purpose: `gpt-5.4-mini` is a different model
  // from `gpt-5.4`, and a prefix rule would hand minis the flagship's window.
  ...exactCapabilities(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], 1_050_000, 128_000, true),
  ...exactCapabilities(["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro"], 1_050_000, 128_000),
  ...exactCapabilities(["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5", "gpt-5-mini", "gpt-5-nano"], 400_000, 128_000),
  ...exactCapabilities(["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"], 1_047_576, 32_768),
  ...exactCapabilities(["gpt-4o", "gpt-4o-mini"], 128_000, 16_384),
  ...exactCapabilities(["o4-mini", "o3", "o3-mini", "o3-pro"], 200_000, 100_000),
];

export function capabilitiesFor(modelId: string | undefined): ModelCapabilities {
  if (!modelId?.trim()) return CONSERVATIVE_CAPABILITIES;
  const normalized = modelId.trim().toLowerCase();
  const candidates = new Set([normalized]);
  const afterSlash = normalized.slice(normalized.lastIndexOf("/") + 1);
  candidates.add(afterSlash);
  const vendorIndex = afterSlash.indexOf("claude-");
  if (vendorIndex > 0) candidates.add(afterSlash.slice(vendorIndex));

  let best: { prefix: string; capabilities: ModelCapabilities } | undefined;
  for (const entry of KNOWN_CAPABILITIES) {
    const matches = [...candidates].some((candidate) => (entry.match === "exact" ? candidate === entry.prefix : candidate.startsWith(entry.prefix)));
    if (!matches) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best?.capabilities ?? CONSERVATIVE_CAPABILITIES;
}

export const DEFAULT_OUTPUT_CEILING = 64_000;

/** The budget pair a session should run with, given what its model can do. */
export function budgetsFor(modelId: string | undefined): { contextLimit: number; maxOutputTokens: number } {
  const capabilities = capabilitiesFor(modelId);
  return {
    contextLimit: capabilities.contextWindow,
    maxOutputTokens: Math.min(capabilities.maxOutputTokens, DEFAULT_OUTPUT_CEILING),
  };
}
