import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveSource, MODEL_CACHE_TTL_MS, modelCacheFile, ModelListService, modelsForProvider } from "./models";
import type { FetchLike } from "./models";

const KEY = "sk-live-secret-123";

function respond(body: unknown, status = 200): ReturnType<FetchLike> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe("modelsForProvider (port of the CLI's)", () => {
  it("lists the default first, then the provider's catalog text models sorted", () => {
    expect(modelsForProvider("anthropic")).toEqual([
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
    ]);
    expect(modelsForProvider("google")).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
  });

  it("offers only the default for providers with no catalog rows", () => {
    expect(modelsForProvider("openrouter")).toEqual(["openrouter/auto"]);
    expect(modelsForProvider("archymedes-cloud")).toEqual(["auto"]);
    expect(modelsForProvider("free")).toEqual(["openrouter/free"]);
    expect(modelsForProvider("openai")).toEqual(["gpt-5.6-terra"]);
  });
});

describe("liveSource", () => {
  it("never puts the key in the cache key", () => {
    const source = liveSource({ provider: "openai", apiKey: KEY, baseUrl: "" }, {});
    expect(source?.cacheKey).toBe("openai https://api.openai.com/v1/models");
    expect(source?.cacheKey).not.toContain(KEY);
    expect(source?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("reads the free catalog without any credential, from a gateway when one is configured", () => {
    expect(liveSource({ provider: "free", apiKey: KEY, baseUrl: "" }, {})).toMatchObject({ url: "https://openrouter.ai/api/v1/models", headers: { accept: "application/json" }, free: true });
    expect(liveSource({ provider: "free", apiKey: "", baseUrl: "https://free.example" }, {})?.url).toBe("https://free.example/v1/models");
  });
});

describe("ModelListService", () => {
  let dir: string;
  let now: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "archymedes-models-"));
    now = Date.UTC(2026, 9, 8);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = (fetchImpl: FetchLike) => new ModelListService({ cacheFile: modelCacheFile(dir), fetchImpl, now: () => now, environment: {} });

  it("returns known models with catalog prices and live extras tagged, chat models only", async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      respond({ data: [{ id: "claude-sonnet-5" }, { id: "claude-opus-6" }, { id: "claude-embed-1" }] }),
    );
    const listing = await service(fetchImpl).list({ provider: "anthropic", apiKey: KEY, baseUrl: "" });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.anthropic.com/v1/models?limit=1000", expect.objectContaining({ headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" } }));
    expect(listing.status).toBe("ok");
    expect(listing.known[0]).toMatchObject({ id: "claude-sonnet-5", isDefault: true, price: { currency: "USD" } });
    expect(listing.known.find((m) => m.id === "claude-opus-5")?.price).toEqual({ currency: "USD", inputPerMillion: 5_000_000, outputPerMillion: 25_000_000 });
    expect(listing.live).toEqual([{ id: "claude-opus-6", isDefault: false, live: true }]);
  });

  it("serves a fresh cache from memory and disk, and refetches on refresh or after 6h", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => respond({ data: [{ id: "gpt-new" }] }));
    const first = service(fetchImpl);
    await first.list({ provider: "openai", apiKey: KEY, baseUrl: "" });
    await first.list({ provider: "openai", apiKey: KEY, baseUrl: "" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A new process reads the disk cache, which holds no credential.
    const onDisk = await readFile(modelCacheFile(dir), "utf8");
    expect(onDisk).toContain("gpt-new");
    expect(onDisk).not.toContain(KEY);
    const second = service(fetchImpl);
    expect((await second.list({ provider: "openai", apiKey: KEY, baseUrl: "" })).live.map((m) => m.id)).toEqual(["gpt-new"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await second.list({ provider: "openai", apiKey: KEY, baseUrl: "", refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += MODEL_CACHE_TTL_MS;
    await second.list({ provider: "openai", apiKey: KEY, baseUrl: "" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reports a failure inline, keeps the known list, and never echoes the key", async () => {
    const listing = await service(() => respond({ error: KEY }, 401)).list({ provider: "groq", apiKey: KEY, baseUrl: "" });
    expect(listing).toMatchObject({ status: "error", error: "provider returned 401", live: [] });
    expect(listing.known.map((m) => m.id)).toEqual(["llama-3.3-70b-versatile"]);
    expect(JSON.stringify(listing)).not.toContain(KEY);
  });

  it("reports an offline provider and does not cache the failure", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.reject(new TypeError("fetch failed")));
    const models = service(fetchImpl);
    expect(await models.list({ provider: "xai", apiKey: KEY, baseUrl: "" })).toMatchObject({ status: "error", error: "fetch failed" });
    await models.list({ provider: "xai", apiKey: KEY, baseUrl: "" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("says no-key without asking, and unsupported for the cloud's auto routing", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    expect(await service(fetchImpl).list({ provider: "openrouter", apiKey: "", baseUrl: "" })).toMatchObject({ status: "no-key", known: [{ id: "openrouter/auto", isDefault: true }] });
    const cloud = await service(fetchImpl).list({ provider: "archymedes-cloud", apiKey: KEY, baseUrl: "https://cloud.example" });
    expect(cloud).toMatchObject({ status: "unsupported", live: [], known: [{ id: "auto", isDefault: true }] });
    expect(cloud.known[0].price).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists OpenRouter models unpriced, including paid and :free ids", async () => {
    const listing = await service(() => respond({ data: [{ id: "anthropic/claude-sonnet-5" }, { id: "openrouter/free" }] })).list({ provider: "openrouter", apiKey: KEY, baseUrl: "" });
    expect(listing.live.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5", "openrouter/free"]);
    expect(listing.live.every((m) => m.price === undefined)).toBe(true);
  });

  it("lists only zero-priced tool-capable :free models for free mode, plus openrouter/free", async () => {
    const free = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      context_length: 32_768,
      pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["tools"],
      ...extra,
    });
    const fetchImpl = vi.fn<FetchLike>(() =>
      respond({
        data: [
          free("google/gemma-4-31b-it:free"),
          free("paid/model:free", { pricing: { prompt: "0.000001", completion: "0" } }),
          free("notools/model:free", { supported_parameters: [] }),
          free("anthropic/claude-sonnet-5"),
          free("openrouter/free"),
        ],
      }),
    );
    const listing = await service(fetchImpl).list({ provider: "free", apiKey: "", baseUrl: "" });
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ accept: "application/json" });
    expect(listing.known).toEqual([{ id: "openrouter/free", isDefault: true, price: { currency: "USD", inputPerMillion: 0, outputPerMillion: 0 } }]);
    expect(listing.live.map((m) => m.id)).toEqual(["google/gemma-4-31b-it:free"]);
  });

  it("shares one request between concurrent callers", async () => {
    let release: () => void = () => {};
    const fetchImpl = vi.fn<FetchLike>(() => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, json: async () => ({ data: ["m"] }) }))));
    const models = service(fetchImpl);
    const both = Promise.all([models.list({ provider: "ollama", apiKey: "", baseUrl: "" }), models.list({ provider: "ollama", apiKey: "", baseUrl: "" })]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await both;
    expect(a.live.map((m) => m.id)).toEqual(["m"]);
    expect(b.live.map((m) => m.id)).toEqual(["m"]);
  });
});
