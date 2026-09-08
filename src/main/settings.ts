import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import type { ProviderSettings } from "../shared/types";
import { getSettingsDir } from "./workspace-store";

/**
 * Provider settings persisted under Electron's userData dir.
 * The API key lives in a plain JSON file for now — same trust boundary as the
 * CLI's env vars — but it never leaves the process except to the chosen
 * provider endpoint.
 */

const SETTINGS_FILE = "provider-settings.json";

function settingsFile(): string {
  return path.join(getSettingsDir(), SETTINGS_FILE);
}

export async function loadSettings(): Promise<ProviderSettings> {
  try {
    const raw = await fs.readFile(settingsFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProviderSettings>;
    return { ...DEFAULT_PROVIDER_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
}

export async function saveSettings(settings: ProviderSettings): Promise<void> {
  await fs.mkdir(getSettingsDir(), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}
