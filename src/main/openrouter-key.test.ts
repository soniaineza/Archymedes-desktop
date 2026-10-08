import { describe, expect, it, vi } from "vitest";
import {
  checkOpenRouterKey,
  KeyInfoService,
  OPENROUTER_KEY_URL,
  parseKeyInfo,
} from "./openrouter-key";

const body = (data: Record<string, unknown>) =>
  new Response(JSON.stringify({ data }), { status: 200 });

describe("parseKeyInfo", () => {
  it("reads the free-model daily counter OpenRouter reports", () => {
    expect(
      parseKeyInfo({
        data: {
          is_free_tier: false,
          free_model_daily_requests: { used: 12, limit: 1000, remaining: 988 },
        },
      }),
    ).toEqual({
      isFreeTier: false,
      dailyRequestLimit: 1000,
      dailyRequestsUsed: 12,
      dailyRequestsRemaining: 988,
    });
  });

  it("falls back to the documented 50/day only for an account that never bought credits", () => {
    expect(parseKeyInfo({ data: { is_free_tier: true } })).toEqual({
      isFreeTier: true,
      dailyRequestLimit: 50,
    });
    expect(parseKeyInfo({ data: { is_free_tier: false } })).toEqual({ isFreeTier: false });
    expect(
      parseKeyInfo({ data: { is_free_tier: true, free_model_daily_requests: { used: 20 } } }),
    ).toEqual({
      isFreeTier: true,
      dailyRequestLimit: 50,
      dailyRequestsUsed: 20,
      dailyRequestsRemaining: 30,
    });
  });

  it("ignores malformed fields", () => {
    expect(parseKeyInfo(null)).toEqual({});
    expect(
      parseKeyInfo({
        data: { is_free_tier: "yes", free_model_daily_requests: { limit: -1, remaining: "5" } },
      }),
    ).toEqual({});
  });
});

describe("checkOpenRouterKey", () => {
  it("asks OpenRouter's key endpoint with the key as a bearer token, and never returns the key", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      body({ is_free_tier: true, label: "sk-or-v1-abc...xyz" }),
    );
    const result = await checkOpenRouterKey("  sk-or-v1-secret  ", { fetchImpl });
    expect(result).toEqual({ ok: true, info: { isFreeTier: true, dailyRequestLimit: 50 } });
    expect(JSON.stringify(result)).not.toContain("secret");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(OPENROUTER_KEY_URL);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-or-v1-secret");
    expect(init?.redirect).toBe("error");
  });

  it("explains each failure without sending an empty or mangled key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(await checkOpenRouterKey("", { fetchImpl })).toEqual({ ok: false, reason: "empty" });
    expect(await checkOpenRouterKey("sk-or one", { fetchImpl })).toEqual({
      ok: false,
      reason: "invalid-key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await checkOpenRouterKey("k", { fetchImpl })).toEqual({
      ok: false,
      reason: "invalid-key",
      status: 401,
    });
    expect(
      await checkOpenRouterKey("k", { fetchImpl: async () => new Response("", { status: 429 }) }),
    ).toEqual({ ok: false, reason: "rate-limited", status: 429 });
    expect(
      await checkOpenRouterKey("k", { fetchImpl: async () => new Response("", { status: 503 }) }),
    ).toEqual({ ok: false, reason: "server", status: 503 });
    expect(
      await checkOpenRouterKey("k", {
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).toEqual({ ok: false, reason: "network" });
  });

  it("gives up after its timeout", async () => {
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    expect(await checkOpenRouterKey("k", { fetchImpl: hanging, timeoutMs: 20 })).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("KeyInfoService", () => {
  it("caches a key's allowance for a minute and counts requests made in between", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () =>
      body({
        is_free_tier: true,
        free_model_daily_requests: { used: 10, limit: 50, remaining: 40 },
      }),
    );
    const service = new KeyInfoService({ fetchImpl, now: () => now });
    expect(await service.get("k1")).toMatchObject({ dailyRequestsRemaining: 40 });
    service.noteRequest("k1");
    service.noteRequest("other-key");
    now = 30_000;
    expect(await service.get("k1")).toMatchObject({
      dailyRequestsRemaining: 39,
      dailyRequestsUsed: 11,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 61_000;
    expect(await service.get("k1")).toMatchObject({ dailyRequestsRemaining: 40 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // A different key is looked up afresh; no key means no lookup.
    await service.get("k2");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await service.get("  ")).toBeNull();
  });

  it("caches a failed lookup as unknown instead of retrying on every refresh", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const service = new KeyInfoService({ fetchImpl, now: () => 0 });
    expect(await service.get("k")).toBeNull();
    expect(await service.get("k")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
