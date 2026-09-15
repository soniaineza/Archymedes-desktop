import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from "../../shared/types";
import type { AdapterEvent, AgentAdapter } from "./adapter";
import { FreeAdapter, freeEndpoint, orderCandidates, parseFreeModels, resetFreeAdapterState } from "./free-adapter";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, context_length: 262_144, top_provider: { max_completion_tokens: 32_768 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"], ...extra,
});
const listing = { data: [row("lab/gated:free", { context_length: 1_000_000 }), row("cohere/north-mini-code:free", { context_length: 256_000 })] };
const settings = (overrides: Partial<ProviderSettings> = {}): ProviderSettings => ({ ...DEFAULT_PROVIDER_SETTINGS, provider: "free", model: "openrouter/free", ...overrides });
const input = (onEvent: (event: AdapterEvent) => void = () => undefined) => ({ systemPrompt: "s", turns: [], tools: [], onEvent, signal: new AbortController().signal });
const fetchListing = vi.fn(async () => new Response(JSON.stringify(listing)));
const failure = (status: number, headers: Record<string, string> = {}) => Object.assign(new Error("upstream"), { status, headers: new Headers(headers) });

afterEach(() => { resetFreeAdapterState(); fetchListing.mockClear(); });

describe("free mode in the desktop app", () => {
  it("sends a key only to OpenRouter, and uses a gateway without one", () => {
    expect(freeEndpoint({ apiKey: " sk-or-x ", baseUrl: "https://evil.test" }, {})).toEqual({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-x" });
    expect(freeEndpoint({ apiKey: "", baseUrl: "https://gw.test/" }, {})).toEqual({ baseUrl: "https://gw.test/v1" });
    expect(freeEndpoint({ apiKey: "", baseUrl: "" }, { ARCHYMEDES_FREE_GATEWAY_URL: "http://localhost:8787" })).toEqual({ baseUrl: "http://localhost:8787/v1" });
    expect(freeEndpoint({ apiKey: "", baseUrl: "http://gw.test" }, {})).toBeUndefined();
    expect(freeEndpoint({ apiKey: "", baseUrl: "" }, {})).toBeUndefined();
  });

  it("accepts only explicitly zero-priced text tool models", () => {
    const models = parseFreeModels({ data: [
      row("a/ok:free"), row("a/paid:free", { pricing: { prompt: "0.1", completion: "0" } }), row("a/music:free", { architecture: { output_modalities: ["audio"] } }),
      row("a/notools:free", { supported_parameters: [] }), row("a/paid"), row("openrouter/free"), row("a/nocontext:free", { context_length: null }),
    ] });
    expect(models.map((model) => model.id)).toEqual(["a/ok:free"]);
    expect(orderCandidates("openrouter/free", parseFreeModels(listing)).map((model) => model.id)).toEqual(["cohere/north-mini-code:free", "lab/gated:free"]);
  });

  it("caps price and output, and moves past a refused model before any output", async () => {
    const attempts: Array<{ model: string; baseUrl: string; apiKey: string; extraBody: Record<string, unknown> }> = [];
    const inner = (attempt: ProviderSettings, extraBody: Record<string, unknown>): AgentAdapter => ({
      name: "inner",
      runTurn: async ({ onEvent }) => {
        attempts.push({ model: attempt.model, baseUrl: attempt.baseUrl, apiKey: attempt.apiKey, extraBody });
        if (attempt.model === "cohere/north-mini-code:free") throw failure(403);
        onEvent({ type: "text-delta", delta: "hi" });
      },
    });
    const events: AdapterEvent[] = [];
    await new FreeAdapter(settings({ apiKey: "sk-or-x" }), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input((event) => events.push(event)));
    expect(attempts.map((attempt) => attempt.model)).toEqual(["cohere/north-mini-code:free", "lab/gated:free"]);
    expect(attempts[0]).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-x",
      extraBody: { max_tokens: 8192, provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 }, allow_fallbacks: false } } });
    expect(events).toEqual([{ type: "text-delta", delta: "hi" }]);
    expect(fetchListing).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.anything());
  });

  it("never switches after output, on a gateway's own limit, or for a chosen model", async () => {
    const run = async (adapterSettings: ProviderSettings, error: Error, emitFirst = false) => {
      const models: string[] = [];
      const inner = (attempt: ProviderSettings): AgentAdapter => ({
        name: "inner",
        runTurn: async ({ onEvent }) => { models.push(attempt.model); if (emitFirst) onEvent({ type: "text-delta", delta: "x" }); throw error; },
      });
      const caught = await new FreeAdapter(adapterSettings, { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input()).catch((e: Error) => e);
      resetFreeAdapterState();
      return { models, caught };
    };
    const gateway = settings({ baseUrl: "https://gw.test" });
    expect((await run(gateway, failure(503), true)).models).toHaveLength(1);
    const limited = await run(gateway, failure(429, { "x-free-gateway-error": "429" }));
    expect(limited.models).toHaveLength(1);
    expect((limited.caught as Error).message).toContain("Free gateway limit");
    expect((await run(settings({ apiKey: "k", model: "lab/gated:free" }), failure(429))).models).toEqual(["lab/gated:free"]);
  });

  it("refuses paid models and missing access before any request", async () => {
    const inner = vi.fn();
    await expect(new FreeAdapter(settings({ apiKey: "k", model: "openai/gpt-5" }), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input())).rejects.toThrow("Paid models");
    await expect(new FreeAdapter(settings(), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input())).rejects.toThrow("free gateway URL");
    expect(inner).not.toHaveBeenCalled();
    expect(fetchListing).not.toHaveBeenCalled();
  });
});
