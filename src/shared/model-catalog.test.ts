import { describe, expect, it } from "vitest";
import {
  filterModelChoices,
  isConversationalModel,
  isFreeModelId,
  mergeModelLists,
  modelsEndpoint,
  modelsUrl,
  parseModelsResponse,
  supportsLiveListing,
} from "./model-catalog";

const KEY = "sk-test-secret";

describe("modelsUrl", () => {
  it("does not double the version segment", () => {
    expect(modelsUrl("https://api.x.ai/v1")).toBe("https://api.x.ai/v1/models");
    expect(modelsUrl("https://api.x.ai/v1/")).toBe("https://api.x.ai/v1/models");
    expect(modelsUrl("https://api.openai.com")).toBe("https://api.openai.com/v1/models");
  });
});

describe("modelsEndpoint", () => {
  it("authenticates Anthropic with x-api-key and the required version header", () => {
    expect(modelsEndpoint("anthropic", { apiKey: KEY, baseUrl: "" })).toEqual({
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    });
  });

  it("uses Bearer auth and each provider's default host", () => {
    const cases = {
      openai: "https://api.openai.com/v1/models",
      openrouter: "https://openrouter.ai/api/v1/models",
      google: "https://generativelanguage.googleapis.com/v1beta/openai/v1/models",
      xai: "https://api.x.ai/v1/models",
      deepseek: "https://api.deepseek.com/v1/models",
      mistral: "https://api.mistral.ai/v1/models",
      groq: "https://api.groq.com/openai/v1/models",
    } as const;
    for (const [provider, url] of Object.entries(cases)) {
      expect(modelsEndpoint(provider as keyof typeof cases, { apiKey: KEY, baseUrl: "" }), provider).toEqual({ url, headers: { authorization: `Bearer ${KEY}` } });
    }
  });

  it("prefers the Base URL override", () => {
    expect(modelsEndpoint("deepseek", { apiKey: KEY, baseUrl: "https://api.deepseek.com" })?.url).toBe("https://api.deepseek.com/v1/models");
    expect(modelsEndpoint("openai-compatible", { apiKey: KEY, baseUrl: "https://gw.example/v1" })?.url).toBe("https://gw.example/v1/models");
  });

  it("asks Ollama without a key", () => {
    expect(modelsEndpoint("ollama", { apiKey: "", baseUrl: "" })).toEqual({ url: "http://localhost:11434/v1/models", headers: {} });
  });

  it("cannot ask without a key, without an endpoint, or for the cloud's routed auto", () => {
    expect(modelsEndpoint("openai", { apiKey: " ", baseUrl: "" })).toBeUndefined();
    expect(modelsEndpoint("openai-compatible", { apiKey: KEY, baseUrl: "" })).toBeUndefined();
    expect(modelsEndpoint("archymedes-cloud", { apiKey: KEY, baseUrl: "https://cloud.example" })).toBeUndefined();
    expect(supportsLiveListing("archymedes-cloud")).toBe(false);
    expect(supportsLiveListing("openrouter")).toBe(true);
  });
});

describe("parseModelsResponse", () => {
  it("reads {data}, {models} and bare arrays with string or object entries, deduplicated", () => {
    expect(parseModelsResponse({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] })).toEqual(["a", "b"]);
    expect(parseModelsResponse({ models: [{ name: "llama3.1" }, "qwen"] })).toEqual(["llama3.1", "qwen"]);
    expect(parseModelsResponse(["x", { id: 3 }, null])).toEqual(["x"]);
    expect(parseModelsResponse("nope")).toEqual([]);
  });
});

describe("isConversationalModel", () => {
  it("drops embeddings, audio, images and moderation models", () => {
    for (const id of ["text-embedding-3-large", "whisper-1", "tts-1", "dall-e-3", "omni-moderation-latest", "gpt-4o-realtime-preview", "llama-guard-3"]) {
      expect(isConversationalModel(id), id).toBe(false);
    }
    expect(isConversationalModel("gpt-5.6-terra")).toBe(true);
  });
});

describe("mergeModelLists", () => {
  it("keeps known order and appends new ids sorted", () => {
    expect(mergeModelLists(["d", "a"], ["z", "a", "b"])).toEqual(["d", "a", "b", "z"]);
    expect(mergeModelLists(["d"], undefined)).toEqual(["d"]);
  });
});

describe("isFreeModelId", () => {
  it("accepts the free router and exact :free ids only", () => {
    expect(isFreeModelId("openrouter/free")).toBe(true);
    expect(isFreeModelId("google/gemma-4-31b-it:free")).toBe(true);
    expect(isFreeModelId("google/gemma-4-31b-it")).toBe(false);
    expect(isFreeModelId("openrouter/auto")).toBe(false);
  });
});

describe("filterModelChoices", () => {
  const choices = ["claude-opus-5-fast", "claude-opus-5", "claude-sonnet-5", "gpt-opus"].map((id) => ({ id }));

  it("ranks exact, then prefix, then substring matches", () => {
    expect(filterModelChoices(choices, "claude-opus-5").map((c) => c.id)).toEqual(["claude-opus-5", "claude-opus-5-fast"]);
    expect(filterModelChoices(choices, "OPUS").map((c) => c.id)).toEqual(["claude-opus-5-fast", "claude-opus-5", "gpt-opus"]);
  });

  it("returns everything for an empty query and nothing for no match", () => {
    expect(filterModelChoices(choices, "  ")).toHaveLength(4);
    expect(filterModelChoices(choices, "mistral")).toEqual([]);
  });
});
