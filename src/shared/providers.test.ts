import { describe, expect, it } from "vitest";
import { formatModelLabel, isProviderId, PROVIDER_IDS, PROVIDER_INFO } from "./providers";

describe("provider registry", () => {
  it("describes every provider id exactly once, under its own key", () => {
    expect(Object.keys(PROVIDER_INFO).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const id of PROVIDER_IDS) expect(PROVIDER_INFO[id].id).toBe(id);
  });

  it("gives every provider a label and a default model", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_INFO[id].label.trim()).not.toBe("");
      expect(PROVIDER_INFO[id].defaultModel.trim()).not.toBe("");
    }
  });

  it("only exempts local Ollama from needing an API key", () => {
    expect(PROVIDER_IDS.filter((id) => !PROVIDER_INFO[id].requiresApiKey)).toEqual(["ollama", "free"]);
  });

  it("uses absolute http(s) URLs for default endpoints", () => {
    for (const id of PROVIDER_IDS) {
      const url = PROVIDER_INFO[id].defaultBaseUrl;
      if (url !== undefined) expect(url).toMatch(/^https?:\/\/[^\s]+$/);
    }
  });

  it("recognizes provider ids", () => {
    expect(isProviderId("groq")).toBe(true);
    expect(isProviderId("Groq")).toBe(false);
    expect(isProviderId("")).toBe(false);
  });

  it("formats the model label shown in the UI", () => {
    expect(formatModelLabel({ provider: "anthropic", model: "claude-sonnet-5" })).toBe("Anthropic · claude-sonnet-5");
  });

  it("falls back to the raw id for an unknown provider", () => {
    expect(formatModelLabel({ provider: "legacy" as never, model: "m" })).toBe("legacy · m");
  });
});
