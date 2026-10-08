import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import { loadSettings, migrateSettings, repairMisplacedKey, saveSettings } from "./settings";

let userData: string;
const file = () => path.join(userData, "settings", "provider-settings.json");

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), "arch-settings-"));
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe("settings store", () => {
  it("returns defaults when nothing has been saved", async () => {
    expect(await loadSettings(userData)).toEqual(DEFAULT_PROVIDER_SETTINGS);
  });

  it("round-trips saved settings", async () => {
    const settings = { ...DEFAULT_PROVIDER_SETTINGS, provider: "groq" as const, model: "llama", apiKey: "k", currency: "RWF", exchangeRate: 1450 };
    await saveSettings(userData, settings);
    expect(await loadSettings(userData)).toEqual(settings);
  });

  it("fills fields that an older settings file lacks", async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify({ provider: "openai", model: "gpt", apiKey: "k" }));
    const loaded = await loadSettings(userData);
    expect(loaded).toMatchObject({ provider: "openai", model: "gpt", apiKey: "k" });
    expect(loaded.currency).toBe(DEFAULT_PROVIDER_SETTINGS.currency);
  });

  it("falls back to defaults for corrupt or invalid files instead of passing junk on", async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), "{ not json");
    expect(await loadSettings(userData)).toEqual(DEFAULT_PROVIDER_SETTINGS);
    await fs.writeFile(file(), JSON.stringify({ provider: "evil-corp" }));
    expect(await loadSettings(userData)).toEqual(DEFAULT_PROVIDER_SETTINGS);
  });

  it("defaults to keyless free mode", async () => {
    const loaded = await loadSettings(userData);
    expect(loaded).toMatchObject({ provider: "free", model: "openrouter/free", apiKey: "" });
  });

  it("moves a keyless Anthropic setup from older builds to free mode", async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify({ ...DEFAULT_PROVIDER_SETTINGS, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "  ", currency: "EUR" }));
    const loaded = await loadSettings(userData);
    expect(loaded).toMatchObject({ provider: "free", model: "openrouter/free", apiKey: "", currency: "EUR" });
  });

  it("keeps Anthropic for users with a key or a custom endpoint", async () => {
    const withKey = { ...DEFAULT_PROVIDER_SETTINGS, provider: "anthropic" as const, model: "claude-x", apiKey: "sk-ant" };
    await saveSettings(userData, withKey);
    expect(await loadSettings(userData)).toEqual(withKey);
    expect(migrateSettings({ ...withKey, apiKey: "", baseUrl: "https://proxy.test" })).toMatchObject({ provider: "anthropic" });
    // Other keyless providers are a deliberate choice and stay put.
    expect(migrateSettings({ ...withKey, provider: "ollama", apiKey: "" })).toMatchObject({ provider: "ollama" });
  });

  it("moves an API key pasted into Base URL to the key field, on load and on save", async () => {
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const misplaced = { ...DEFAULT_PROVIDER_SETTINGS, provider: "free" as const, model: "openrouter/free", apiKey: "", baseUrl: ` ${key} ` };
    expect(repairMisplacedKey(misplaced)).toMatchObject({ apiKey: key, baseUrl: "" });
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(misplaced));
    expect(await loadSettings(userData)).toMatchObject({ provider: "free", apiKey: key, baseUrl: "" });
    await saveSettings(userData, misplaced);
    expect(JSON.parse(await fs.readFile(file(), "utf8"))).toMatchObject({ apiKey: key, baseUrl: "" });
  });

  it("leaves a real Base URL, or a key already in place, alone", () => {
    const base = { ...DEFAULT_PROVIDER_SETTINGS, provider: "free" as const, model: "openrouter/free" };
    expect(repairMisplacedKey({ ...base, apiKey: "", baseUrl: "https://gateway.example" })).toMatchObject({ apiKey: "", baseUrl: "https://gateway.example" });
    expect(repairMisplacedKey({ ...base, apiKey: "sk-real", baseUrl: "sk-or-v1-0123456789abcdef0123" })).toMatchObject({ apiKey: "sk-real" });
  });

  it("leaves no temporary files behind", async () => {
    await saveSettings(userData, DEFAULT_PROVIDER_SETTINGS);
    expect(await fs.readdir(path.dirname(file()))).toEqual(["provider-settings.json"]);
  });
});
