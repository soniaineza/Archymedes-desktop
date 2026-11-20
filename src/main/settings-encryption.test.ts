import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import { keyStorageFromSafeStorage, loadSettings, saveSettings } from "./settings";
import type { SafeStorageLike } from "./settings";

/** A stand-in for Electron's safeStorage: reversible, but never the plaintext. */
function mockSafeStorage(opts: { available?: boolean; backend?: string } = {}): SafeStorageLike & {
  encryptString: ReturnType<typeof vi.fn>;
  decryptString: ReturnType<typeof vi.fn>;
} {
  return {
    isEncryptionAvailable: vi.fn(() => opts.available ?? true),
    getSelectedStorageBackend: vi.fn(() => opts.backend ?? "gnome_libsecret"),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString("hex")}`)),
    decryptString: vi.fn((enc: Buffer) => {
      const text = enc.toString();
      if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
      return Buffer.from(text.slice(4), "hex").toString();
    }),
  };
}

const KEY = "sk-ant-secret-0123456789";
let userData: string;
const file = () => path.join(userData, "settings", "provider-settings.json");
const withKey = { ...DEFAULT_PROVIDER_SETTINGS, provider: "anthropic" as const, model: "claude-x", apiKey: KEY };

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), "arch-settings-enc-"));
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe("keyStorageFromSafeStorage", () => {
  it("uses safeStorage when encryption is available", () => {
    const safe = mockSafeStorage();
    expect(keyStorageFromSafeStorage(safe, "linux", {})).toEqual({ cipher: safe, allowPlaintext: false });
    expect(keyStorageFromSafeStorage(safe, "win32", {}).cipher).toBe(safe);
  });

  it("treats Linux's basic_text backend (no keyring) as unavailable", () => {
    const safe = mockSafeStorage({ backend: "basic_text" });
    expect(keyStorageFromSafeStorage(safe, "linux", {}).cipher).toBeNull();
  });

  it("has no cipher when encryption is unavailable", () => {
    expect(keyStorageFromSafeStorage(mockSafeStorage({ available: false }), "darwin", {}).cipher).toBeNull();
  });

  it("allows plaintext only on an explicit opt-in", () => {
    const safe = mockSafeStorage({ backend: "basic_text" });
    expect(keyStorageFromSafeStorage(safe, "linux", { ARCHYMEDES_ALLOW_PLAINTEXT_KEYS: "1" }).allowPlaintext).toBe(true);
    expect(keyStorageFromSafeStorage(safe, "linux", { ARCHYMEDES_ALLOW_PLAINTEXT_KEYS: "yes" }).allowPlaintext).toBe(false);
  });
});

describe("encrypted settings", () => {
  it("never writes the API key in plaintext and round-trips it", async () => {
    const storage = { cipher: mockSafeStorage(), allowPlaintext: false };
    await saveSettings(userData, withKey, storage);
    const raw = await fs.readFile(file(), "utf8");
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw)).toMatchObject({ apiKey: "", apiKeyEncrypted: expect.any(String) });
    expect(await loadSettings(userData, storage)).toEqual(withKey);
  });

  it("writes no ciphertext for an empty key", async () => {
    const storage = { cipher: mockSafeStorage(), allowPlaintext: false };
    await saveSettings(userData, DEFAULT_PROVIDER_SETTINGS, storage);
    expect(JSON.parse(await fs.readFile(file(), "utf8"))).not.toHaveProperty("apiKeyEncrypted");
    expect(storage.cipher.encryptString).not.toHaveBeenCalled();
  });

  it("migrates an existing plaintext file to encrypted on read", async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(withKey));
    const storage = { cipher: mockSafeStorage(), allowPlaintext: false };
    expect(await loadSettings(userData, storage)).toEqual(withKey);
    const raw = await fs.readFile(file(), "utf8");
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw)).toHaveProperty("apiKeyEncrypted");
    expect(await loadSettings(userData, storage)).toEqual(withKey);
  });

  it("fails closed with a clear message when encryption is unavailable and plaintext was not opted into", async () => {
    const storage = { cipher: null, allowPlaintext: false };
    await expect(saveSettings(userData, withKey, storage)).rejects.toThrow(/keyring.*ARCHYMEDES_ALLOW_PLAINTEXT_KEYS=1/s);
    await expect(fs.readFile(file(), "utf8")).rejects.toThrow();
    // Settings without a key still save: nothing secret is at stake.
    await saveSettings(userData, DEFAULT_PROVIDER_SETTINGS, storage);
    expect(await loadSettings(userData, storage)).toEqual(DEFAULT_PROVIDER_SETTINGS);
  });

  it("stores plaintext only with the explicit opt-in", async () => {
    const storage = { cipher: null, allowPlaintext: true };
    await saveSettings(userData, withKey, storage);
    expect(JSON.parse(await fs.readFile(file(), "utf8"))).toMatchObject({ apiKey: KEY });
    expect(await loadSettings(userData, storage)).toEqual(withKey);
  });

  it("returns an empty key, and leaves the file alone, when the ciphertext cannot be decrypted", async () => {
    await saveSettings(userData, withKey, { cipher: mockSafeStorage(), allowPlaintext: false });
    const before = await fs.readFile(file(), "utf8");
    const loaded = await loadSettings(userData, { cipher: null, allowPlaintext: false });
    expect(loaded).toMatchObject({ provider: "anthropic", apiKey: "" });
    expect(await fs.readFile(file(), "utf8")).toBe(before);
  });
});
