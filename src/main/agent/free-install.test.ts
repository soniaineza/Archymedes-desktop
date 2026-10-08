import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileFreeInstallStore, FreeInstallToken, userDataInstallFile, type FreeInstallFetch, type StoredInstall } from "./free-install";

const issued = (token: string) =>
  new Response(JSON.stringify({ token, install_id: "abc", issued_at: "2026-10-07T12:00:00.000Z", header: "x-archymedes-install" }));
const memoryStore = (initial?: StoredInstall) => {
  let saved = initial;
  return {
    read: vi.fn(async () => saved),
    write: vi.fn(async (value: StoredInstall) => {
      saved = value;
    }),
    clear: vi.fn(async () => {
      saved = undefined;
    }),
    saved: () => saved,
  };
};

let root: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("free gateway install token (desktop)", () => {
  it("issues once with POST /v1/install, stores it, and shares one request between concurrent callers", async () => {
    const fetchImpl = vi.fn(async () => issued("v1.a.b"));
    const store = memoryStore();
    const install = new FreeInstallToken({ gatewayUrl: "https://gw.test/", store, fetchImpl });
    expect(await Promise.all([install.get(), install.get(), install.get()])).toEqual(["v1.a.b", "v1.a.b", "v1.a.b"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://gw.test/v1/install", expect.objectContaining({ method: "POST", redirect: "error" }));
    expect(store.saved()).toEqual({ gateway: "https://gw.test", token: "v1.a.b", install_id: "abc", issued_at: "2026-10-07T12:00:00.000Z" });
  });

  it("reuses a stored token for the same gateway only", async () => {
    const fetchImpl = vi.fn(async () => issued("v1.new.sig"));
    const same = new FreeInstallToken({ gatewayUrl: "https://gw.test", store: memoryStore({ gateway: "https://gw.test", token: "v1.old.sig" }), fetchImpl });
    expect(await same.get()).toBe("v1.old.sig");
    expect(fetchImpl).not.toHaveBeenCalled();
    const other = new FreeInstallToken({ gatewayUrl: "https://gw.test", store: memoryStore({ gateway: "https://other.test", token: "v1.old.sig" }), fetchImpl });
    expect(await other.get()).toBe("v1.new.sig");
  });

  it.each([
    [429, { "x-free-gateway-error": "429", "retry-after": "60" }],
    [503, { "x-free-gateway-error": "503" }],
  ])("continues without a token on %s and backs off", async (status, headers) => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "no", code: status } }), { status, headers }));
    const install = new FreeInstallToken({ gatewayUrl: "https://gw.test", fetchImpl, now: () => now });
    expect(await install.get()).toBeUndefined();
    expect(await install.get()).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 11 * 60_000;
    await install.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a network failure or a malformed answer as no token", async () => {
    const failing = new FreeInstallToken({
      gatewayUrl: "https://gw.test",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await failing.get()).toBeUndefined();
    const malformed = new FreeInstallToken({ gatewayUrl: "https://gw.test", fetchImpl: async () => new Response(JSON.stringify({ token: "has spaces\n" })) });
    expect(await malformed.get()).toBeUndefined();
  });

  it("never makes a request wait longer than the bound", async () => {
    vi.useFakeTimers();
    const fetchImpl: FreeInstallFetch = () => new Promise(() => undefined);
    const pending = new FreeInstallToken({ gatewayUrl: "https://gw.test", fetchImpl, timeoutMs: 5_000 }).get();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it("drops an invalid token and re-issues once; a second rejection stops sending tokens", async () => {
    let count = 0;
    const fetchImpl = vi.fn(async () => issued(`v1.t${++count}.s`));
    const store = memoryStore();
    const install = new FreeInstallToken({ gatewayUrl: "https://gw.test", store, fetchImpl });
    const first = await install.get();
    install.observe("invalid", "v1.someone-else.s");
    expect(install.current()).toBe(first);
    install.observe("invalid", first);
    expect(install.current()).toBeUndefined();
    expect(store.saved()).toBeUndefined();
    const second = await install.get();
    expect(second).toBe("v1.t2.s");
    install.observe("invalid", second);
    expect(await install.get()).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stores the token in a file readable only by its owner where supported, and nothing outside Electron", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "archymedes-desktop-install-"));
    const file = path.join(root, "nested", "free-install.json");
    const store = fileFreeInstallStore(file);
    expect(await store.read()).toBeUndefined();
    await store.write({ gateway: "https://gw.test", token: "v1.a.b" });
    expect(await store.read()).toEqual({ gateway: "https://gw.test", token: "v1.a.b" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ token: "v1.a.b" });
    await writeFile(file, "{not json");
    expect(await store.read()).toBeUndefined();
    await store.clear();
    await expect(stat(file)).rejects.toThrow();
    // Outside the Electron main process there is no userData directory: the token stays in memory.
    expect(await userDataInstallFile()).toBeUndefined();
    const lazy = fileFreeInstallStore(async () => undefined);
    await lazy.write({ gateway: "https://gw.test", token: "v1.a.b" });
    expect(await lazy.read()).toBeUndefined();
  });
});
