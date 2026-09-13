import fs from "node:fs/promises";
import path from "node:path";
import { providerSettings } from "../shared/ipc-guards";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import type { ProviderSettings } from "../shared/types";

/**
 * Provider settings persisted under the app's userData dir. The API key lives
 * in a plain JSON file for now — same trust boundary as the CLI's env vars.
 */

function settingsFile(userDataPath: string): string {
  return path.join(userDataPath, "settings", "provider-settings.json");
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
    return providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, ...(JSON.parse(raw) as object) }, "settings");
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
}

export async function saveSettings(userDataPath: string, settings: ProviderSettings): Promise<void> {
  const file = settingsFile(userDataPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated settings file.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(settings, null, 2), "utf8");
  await fs.rename(temp, file);
}
