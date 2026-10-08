import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from "../../shared/types";
import type { AdapterEvent, AgentAdapter } from "./adapter";
import { StreamTimeoutError } from "./stream-deadline";
import { APIConnectionError, APIError } from "openai";
import { allowanceOf, FREE_FIRST_BYTE_MS, FreeAdapter, freeEndpoint, freeFailureStatus, friendly, limitOf, orderCandidates, parseFreeModels, resetFreeAdapterState, type FreeTuning } from "./free-adapter";
import { ModelHealthStore } from "./model-health";
import { FreeInstallToken } from "./free-install";

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
    expect(events).toEqual([
      { type: "retry", reason: expect.stringContaining("cohere/north-mini-code:free") },
      { type: "text-delta", delta: "hi" },
    ]);
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

  it("gives each free model a short first-byte deadline and moves on when one stalls", async () => {
    const tunings: unknown[] = [];
    const models: string[] = [];
    const inner = (attempt: ProviderSettings, _extraBody: Record<string, unknown>, tuning: unknown): AgentAdapter => ({
      name: "inner",
      runTurn: async ({ onEvent }) => {
        models.push(attempt.model);
        tunings.push(tuning);
        if (models.length === 1) throw new StreamTimeoutError("first-byte", FREE_FIRST_BYTE_MS);
        onEvent({ type: "text-delta", delta: "ok" });
      },
    });
    const events: AdapterEvent[] = [];
    await new FreeAdapter(settings({ apiKey: "k" }), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input((event) => events.push(event)));
    expect(models).toEqual(["cohere/north-mini-code:free", "lab/gated:free"]);
    expect(tunings[0]).toEqual({ deadline: { firstByteMs: 45_000 }, maxRetries: 0 });
    expect(events.map((event) => event.type)).toEqual(["retry", "text-delta"]);
  });

  it("does not switch models when a reply stalls after it started", async () => {
    const models: string[] = [];
    const inner = (attempt: ProviderSettings): AgentAdapter => ({
      name: "inner",
      runTurn: async ({ onEvent }) => {
        models.push(attempt.model);
        onEvent({ type: "text-delta", delta: "partial" });
        throw new StreamTimeoutError("idle", 90_000);
      },
    });
    const caught = await new FreeAdapter(settings({ apiKey: "k" }), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input()).catch((e: Error) => e);
    expect(models).toHaveLength(1);
    expect(caught).toBeInstanceOf(StreamTimeoutError);
  });

  it("fails over on the gateway's retryable stream error event, and on its 502/504 errors, before any output", async () => {
    // What the OpenAI SDK throws for `data: {"error":{...}}` in a stream: an APIError without a status.
    const streamEvent = new APIError(undefined, { message: "The model stopped responding.", code: 504, type: "upstream_idle_timeout", retryable: true }, undefined, {});
    for (const error of [streamEvent, failure(504), failure(502)]) {
      const models: string[] = [];
      const inner = (attempt: ProviderSettings): AgentAdapter => ({
        name: "inner",
        runTurn: async ({ onEvent }) => {
          models.push(attempt.model);
          if (models.length === 1) throw error;
          onEvent({ type: "text-delta", delta: "ok" });
        },
      });
      await new FreeAdapter(settings({ baseUrl: "https://gw.test" }), { inner, fetchImpl: fetchListing, environment: {}, install: null }).runTurn(input());
      expect(models).toEqual(["cohere/north-mini-code:free", "lab/gated:free"]);
      resetFreeAdapterState();
    }
    expect(freeFailureStatus(streamEvent)).toBe(504);
    expect(freeFailureStatus(new APIError(undefined, { message: "x", code: 502, type: "upstream_stream_failed", retryable: true }, undefined, {}))).toBe(502);
    expect(freeFailureStatus(new Error("plain"))).toBeUndefined();
  });

  it("reads gateway headers from openai v4's plain-record APIError.headers too", async () => {
    const models: string[] = [];
    const inner = (attempt: ProviderSettings): AgentAdapter => ({
      name: "inner",
      runTurn: async () => {
        models.push(attempt.model);
        throw new APIError(429, { message: "Free request limit reached for this install.", code: 429 }, "limit", { "x-free-gateway-error": "429" });
      },
    });
    const caught = await new FreeAdapter(settings({ baseUrl: "https://gw.test" }), { inner, fetchImpl: fetchListing, environment: {}, install: null }).runTurn(input()).catch((e: Error) => e);
    expect(models).toHaveLength(1);
    // A gateway-owned 429 shows the gateway's own message.
    expect((caught as Error).message).toBe("Free request limit reached for this install.");
  });

  it("does not fail over when the stream error event follows output", async () => {
    const models: string[] = [];
    const inner = (attempt: ProviderSettings): AgentAdapter => ({
      name: "inner",
      runTurn: async ({ onEvent }) => {
        models.push(attempt.model);
        onEvent({ type: "text-delta", delta: "partial" });
        throw new APIError(undefined, { message: "broke", code: 502, type: "upstream_stream_failed", retryable: true }, undefined, {});
      },
    });
    const caught = await new FreeAdapter(settings({ baseUrl: "https://gw.test" }), { inner, fetchImpl: fetchListing, environment: {}, install: null }).runTurn(input()).catch((e: Error) => e);
    expect(models).toHaveLength(1);
    expect(caught).toMatchObject({ status: 502 });
  });

  it("sends the gateway install token and replaces it once when the gateway calls it invalid", async () => {
    let issued = 0;
    const installFetch = vi.fn(async () => new Response(JSON.stringify({ token: `v1.t${++issued}.s`, install_id: "id", issued_at: "2026-10-07T12:00:00.000Z" })));
    const install = new FreeInstallToken({ gatewayUrl: "https://gw.test", fetchImpl: installFetch });
    const sent: Array<string | undefined> = [];
    const inner = (_attempt: ProviderSettings, _extraBody: Record<string, unknown>, tuning: FreeTuning): AgentAdapter => ({
      name: "inner",
      runTurn: async ({ onEvent }) => {
        const token = tuning.headers?.["x-archymedes-install"];
        sent.push(token);
        tuning.onResponseHeaders?.(new Headers({ "x-archymedes-install-status": token === "v1.t1.s" ? "invalid" : "valid" }));
        onEvent({ type: "text-delta", delta: "ok" });
      },
    });
    const adapter = new FreeAdapter(settings({ baseUrl: "https://gw.test" }), { inner, fetchImpl: fetchListing, environment: {}, install });
    await adapter.runTurn(input());
    await adapter.runTurn(input());
    await adapter.runTurn(input());
    expect(sent).toEqual(["v1.t1.s", "v1.t2.s", "v1.t2.s"]);
    expect(installFetch).toHaveBeenCalledTimes(2);
    expect(installFetch).toHaveBeenCalledWith("https://gw.test/v1/install", expect.objectContaining({ method: "POST" }));
  });

  it("never requests an install token when the user's own key goes direct", async () => {
    const tunings: FreeTuning[] = [];
    const inner = (_attempt: ProviderSettings, _extraBody: Record<string, unknown>, tuning: FreeTuning): AgentAdapter => ({
      name: "inner",
      runTurn: async () => { tunings.push(tuning); },
    });
    await new FreeAdapter(settings({ apiKey: "sk-or-x" }), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input());
    expect((fetchListing.mock.calls as unknown as [string][]).map(([url]) => url)).toEqual(["https://openrouter.ai/api/v1/models"]);
    expect(tunings[0]).not.toHaveProperty("headers");
    expect(tunings[0]).not.toHaveProperty("onResponseHeaders");
  });

  it("reports an unreachable gateway as a connection problem", async () => {
    const inner = (): AgentAdapter => ({
      name: "inner",
      runTurn: async () => { throw new APIConnectionError({ cause: new TypeError("fetch failed") }); },
    });
    const caught = await new FreeAdapter(settings({ baseUrl: "https://gw.test" }), { inner, fetchImpl: fetchListing, environment: {}, install: null }).runTurn(input()).catch((e: Error) => e);
    expect((caught as Error).message).toContain("Could not reach the free gateway");
  });

  it("explains that free mode is unavailable, without asking for a key, when no gateway is set", async () => {
    const caught = await new FreeAdapter(settings(), { inner: vi.fn(), fetchImpl: fetchListing, environment: {} }).runTurn(input()).catch((e: Error) => e);
    expect(caught).toMatchObject({ code: "free-unavailable" });
    expect((caught as Error).message).not.toMatch(/API key/i);
  });

  it("refuses paid models and missing access before any request", async () => {
    const inner = vi.fn();
    await expect(new FreeAdapter(settings({ apiKey: "k", model: "openai/gpt-5" }), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input())).rejects.toThrow("Paid models");
    await expect(new FreeAdapter(settings(), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input())).rejects.toThrow("free gateway URL");
    expect(inner).not.toHaveBeenCalled();
    expect(fetchListing).not.toHaveBeenCalled();
  });

  it("reports the gateway's allowance headers from successful and refused responses", async () => {
    const inner = (_attempt: ProviderSettings, _extraBody: Record<string, unknown>, tuning: FreeTuning): AgentAdapter => ({
      name: "inner",
      runTurn: async ({ onEvent }) => {
        tuning.onResponseHeaders?.(new Headers({
          "x-free-remaining-tokens": "20000", "x-free-reset-utc": "2026-10-09T00:00:00.000Z", "x-free-allowance-warning": "You've used 80% of today's free allowance.",
        }));
        onEvent({ type: "text-delta", delta: "ok" });
      },
    });
    const events: AdapterEvent[] = [];
    await new FreeAdapter(settings({ baseUrl: "https://gw.test" }), { inner, fetchImpl: fetchListing, environment: {}, install: null }).runTurn(input((event) => events.push(event)));
    expect(events[0]).toEqual({ type: "allowance", remainingTokens: 20_000, resetUtc: "2026-10-09T00:00:00.000Z", warning: "You've used 80% of today's free allowance." });

    // The user's own key goes straight to OpenRouter, which sends no allowance headers.
    const direct: AdapterEvent[] = [];
    await new FreeAdapter(settings({ apiKey: "sk-or-x" }), { inner, fetchImpl: fetchListing, environment: {} }).runTurn(input((event) => direct.push(event)));
    expect(direct.map((event) => event.type)).toEqual(["text-delta"]);
  });

  it("shows the gateway's own 429 message, with its reset time, instead of a generic one", async () => {
    const message = "You've reached today's free usage limit (100,000 tokens). Your allowance resets at 2026-10-09T00:00:00.000Z. Type /upgrade to use your own OpenRouter API key.";
    const refused = new APIError(429, { message, code: 429 }, undefined, {
      "x-free-gateway-error": "429", "x-free-remaining-tokens": "0", "x-free-reset-utc": "2026-10-09T00:00:00.000Z", "retry-after": "3600",
    });
    const inner = (): AgentAdapter => ({ name: "inner", runTurn: async () => { throw refused; } });
    const events: AdapterEvent[] = [];
    const caught = await new FreeAdapter(settings({ baseUrl: "https://gw.test" }), { inner, fetchImpl: fetchListing, environment: {}, install: null })
      .runTurn(input((event) => events.push(event))).catch((e: Error) => e);
    expect((caught as Error).message).toContain("resets at 2026-10-09T00:00:00.000Z");
    expect((caught as Error).message).toContain("OpenRouter API key in Settings");
    expect((caught as Error).message).not.toContain("/upgrade");
    expect(events).toContainEqual({ type: "allowance", remainingTokens: 0, resetUtc: "2026-10-09T00:00:00.000Z" });
  });
});

describe("free mode: allowance, error mapping and model health", () => {
  it("reads the gateway's requests-left header, alone or beside the tokens header", () => {
    expect(allowanceOf(new Headers({ "x-free-remaining-requests": "37", "x-free-reset-utc": "2026-10-09T00:00:00.000Z" })))
      .toEqual({ remainingRequests: 37, resetUtc: "2026-10-09T00:00:00.000Z" });
    expect(allowanceOf({ "x-free-remaining-tokens": "900", "x-free-remaining-requests": "4" })).toEqual({ remainingTokens: 900, remainingRequests: 4 });
    expect(allowanceOf(new Headers({ "x-free-remaining-requests": "lots" }))).toBeNull();
    expect(allowanceOf(undefined)).toBeNull();
  });

  it("tells a per-minute limit from a daily one by the gateway's JSON kind", () => {
    const body = (kind: string) => ({ message: "limited", code: 429, kind, reset_utc: "2026-10-09T00:00:00.000Z", retry_after_seconds: 42 });
    const minute = friendly(new APIError(429, body("per_minute"), undefined, { "x-free-gateway-error": "429" }), true);
    expect(minute).toMatchObject({ code: "free-rate-minute", params: { seconds: 42 }, message: "limited" });
    const daily = friendly(new APIError(429, body("daily_requests"), undefined, { "x-free-gateway-error": "429" }), true);
    expect(daily).toMatchObject({ code: "free-daily-limit", params: { time: "00:00" } });
    expect(friendly(new APIError(429, body("daily_tokens"), undefined, { "x-free-gateway-error": "429" }), true)).toMatchObject({ code: "free-daily-limit" });
    // An older gateway without the body still works from retry-after and the message.
    expect(limitOf(new APIError(429, { message: "x" }, undefined, { "retry-after": "30" }))).toBeUndefined();
  });

  it("maps OpenRouter's own free-model limits, data policy, bad key, credits and unavailable models", () => {
    const perDay = new APIError(429, { message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", code: 429 }, undefined, {
      "x-ratelimit-reset": String(Date.parse("2026-10-09T00:00:00Z")),
    });
    expect(friendly(perDay, false)).toMatchObject({ code: "free-daily-limit", params: { time: "00:00" } });
    const perMinute = new APIError(429, { message: "Rate limit exceeded: free-models-per-min.", code: 429 }, undefined, { "retry-after": "12" });
    expect(friendly(perMinute, false)).toMatchObject({ code: "free-rate-minute", params: { seconds: 12 } });
    const policy = new APIError(404, { message: "No endpoints found matching your data policy (Free model publication). Configure: https://openrouter.ai/settings/privacy", code: 404 }, undefined, {});
    expect(friendly(policy, false)).toMatchObject({ code: "free-data-policy" });
    expect(friendly(failure(401), false)).toMatchObject({ code: "free-bad-key" });
    expect(friendly(failure(402), false)).toMatchObject({ code: "free-credits" });
    expect(friendly(failure(404), false)).toMatchObject({ code: "free-model-unavailable" });
    // A provider's own 429 names no limit and keeps the generic message.
    expect(friendly(failure(429), false)).not.toHaveProperty("code");
  });

  it("does not spend more requests on other models after an OpenRouter account-wide limit", async () => {
    const models: string[] = [];
    const inner = (attempt: ProviderSettings): AgentAdapter => ({
      name: "inner",
      runTurn: async () => {
        models.push(attempt.model);
        throw new APIError(429, { message: "Rate limit exceeded: free-models-per-day", code: 429 }, undefined, {});
      },
    });
    const caught = await new FreeAdapter(settings({ apiKey: "k" }), { inner, fetchImpl: fetchListing, environment: {}, health: null }).runTurn(input()).catch((e: Error) => e);
    expect(models).toHaveLength(1);
    expect(caught).toMatchObject({ code: "free-daily-limit" });
  });

  it("tries models that answered recently first, and records failures and successes", async () => {
    const health = new ModelHealthStore(undefined, () => 1_000);
    await health.recordSuccess("lab/gated:free");
    const models: string[] = [];
    const inner = (attempt: ProviderSettings): AgentAdapter => ({
      name: "inner",
      runTurn: async ({ onEvent }) => {
        models.push(attempt.model);
        if (attempt.model === "lab/gated:free") throw failure(503);
        onEvent({ type: "text-delta", delta: "ok" });
      },
    });
    await new FreeAdapter(settings({ apiKey: "k" }), { inner, fetchImpl: fetchListing, environment: {}, health }).runTurn(input());
    // Preferred order would put cohere first; the healthier model goes first instead.
    expect(models).toEqual(["lab/gated:free", "cohere/north-mini-code:free"]);
    await vi.waitFor(async () => {
      const snapshot = await health.snapshot();
      expect(snapshot["lab/gated:free"]).toMatchObject({ success: 1, failure: 1, lastError: "HTTP 503" });
      expect(snapshot["cohere/north-mini-code:free"]).toMatchObject({ success: 1, failure: 0 });
    });
  });
});
