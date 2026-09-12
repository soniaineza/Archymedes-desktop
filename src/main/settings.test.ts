import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import { loadSettings, saveSettings } from "./settings";

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

  it("leaves no temporary files behind", async () => {
    await saveSettings(userData, DEFAULT_PROVIDER_SETTINGS);
    expect(await fs.readdir(path.dirname(file()))).toEqual(["provider-settings.json"]);
  });
});
