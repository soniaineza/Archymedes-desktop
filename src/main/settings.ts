import fs from "node:fs/promises";
import path from "node:path";
import { providerSettings } from "../shared/ipc-guards";
import { PROVIDER_INFO } from "../shared/providers";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import type { ProviderSettings } from "../shared/types";

/**
 * Provider settings persisted under the app's userData dir. The API key lives
 * in a plain JSON file for now — same trust boundary as the CLI's env vars.
 */

function settingsFile(userDataPath: string): string {
  return path.join(userDataPath, "settings", "provider-settings.json");
}

/**
 * Older builds defaulted to Anthropic with no key, which could never run. Such a file moves to the
 * keyless free mode. Anyone who entered a key, or a custom Base URL, keeps their choice.
 */
/** An API key, not an address: `sk-…`, no scheme, no dots, no spaces. */
const LOOKS_LIKE_API_KEY = /^sk-[A-Za-z0-9_-]{16,}$/;

/**
 * A key pasted into Base URL instead of API key.
 *
 * Free mode marks the API key box "not required", so the key easily lands in the box below it —
 * where it is read as a gateway address, rejected, and free mode fails with no sign of why. A
 * value that can only be a key moves to the key field when that is empty; anything else is left.
 */
export function repairMisplacedKey(settings: ProviderSettings): ProviderSettings {
  const baseUrl = settings.baseUrl.trim();
  if (!settings.apiKey.trim() && LOOKS_LIKE_API_KEY.test(baseUrl)) return { ...settings, apiKey: baseUrl, baseUrl: "" };
  return settings;
}

export function migrateSettings(settings: ProviderSettings): ProviderSettings {
  settings = repairMisplacedKey(settings);
  if (settings.provider === "anthropic" && !settings.apiKey.trim() && !settings.baseUrl.trim()) {
    return { ...settings, provider: "free", model: PROVIDER_INFO.free.defaultModel, apiKey: "" };
  }
  return settings;
}

export async function loadSettings(userDataPath: string): Promise<ProviderSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsFile(userDataPath), "utf8");
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
  try {
    // Defaults fill fields an older file lacks; the guard rejects anything malformed.
    return migrateSettings(providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, ...(JSON.parse(raw) as object) }, "settings"));
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
}

export async function saveSettings(userDataPath: string, settings: ProviderSettings): Promise<void> {
  const file = settingsFile(userDataPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated settings file.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(repairMisplacedKey(settings), null, 2), "utf8");
  await fs.rename(temp, file);
}
