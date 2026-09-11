import { describe, expect, it } from "vitest";
import { CONSERVATIVE_CAPABILITIES, budgetsFor, capabilitiesFor } from "./model-capabilities";

describe("capabilitiesFor", () => {
  it("falls back to conservative defaults for an unknown model", () => {
    expect(capabilitiesFor("some-future-model")).toEqual(CONSERVATIVE_CAPABILITIES);
  });

  it("falls back to conservative defaults for an empty/undefined model", () => {
    expect(capabilitiesFor(undefined)).toEqual(CONSERVATIVE_CAPABILITIES);
    expect(capabilitiesFor("  ")).toEqual(CONSERVATIVE_CAPABILITIES);
  });

  it("prefers the longest matching prefix over a shorter one", () => {
    // "gemini-2.5-pro" (specific) should win over the generic "gemini" prefix.
    expect(capabilitiesFor("gemini-2.5-pro").supportsEffort).toBe(true);
    expect(capabilitiesFor("gemini-1.5-flash").supportsEffort).toBe(false);
  });

  it("matches exact-only entries by full id, not by prefix", () => {
    // gpt-4o-mini has its own exact entry distinct from gpt-4o.
    expect(capabilitiesFor("gpt-4o-mini").maxOutputTokens).toBe(16_384);
    expect(capabilitiesFor("gpt-4o").maxOutputTokens).toBe(16_384);
    // An exact-match model id with extra suffix should NOT match the exact entry.
    expect(capabilitiesFor("gpt-4o-mini-preview")).toEqual(CONSERVATIVE_CAPABILITIES);
  });

  it("normalizes a vendor/model id by stripping the vendor prefix", () => {
    expect(capabilitiesFor("anthropic/claude-sonnet-5").contextWindow).toBe(1_000_000);
  });

  it("is case-insensitive", () => {
    expect(capabilitiesFor("GPT-4O").maxOutputTokens).toBe(16_384);
  });
});

describe("budgetsFor", () => {
  it("caps maxOutputTokens at the default ceiling even for larger models", () => {
    const budgets = budgetsFor("claude-opus-5"); // capability table says 128_000
    expect(budgets.maxOutputTokens).toBe(64_000); // DEFAULT_OUTPUT_CEILING
  });

  it("passes through a smaller maxOutputTokens unchanged", () => {
    const budgets = budgetsFor("gpt-4o"); // 16_384, below the ceiling
    expect(budgets.maxOutputTokens).toBe(16_384);
  });
});
