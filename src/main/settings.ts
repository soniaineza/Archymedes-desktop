import fs from "node:fs/promises";
import path from "node:path";
import { providerSettings } from "../shared/ipc-guards";
import { PROVIDER_INFO } from "../shared/providers";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import type { ProviderSettings } from "../shared/types";

/**
 * Provider settings persisted under the app's userData dir. The API key is
 * encrypted with the OS keystore (Electron safeStorage: Keychain, DPAPI,
 * libsecret/kwallet) and stored as `apiKeyEncrypted`; the plaintext `apiKey`
 * field on disk is always empty. Without a keystore the key is not written at
 * all unless the user opts in to plaintext (ARCHYMEDES_ALLOW_PLAINTEXT_KEYS=1).
 */

/** The parts of Electron's safeStorage this module uses; tests pass a fake. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only in Electron; "basic_text" means no keyring (a hard-coded key). */
  getSelectedStorageBackend?(): string;
}

export interface KeyStorage {
  /** null = no OS keystore available. */
  cipher: SafeStorageLike | null;
  /** The user's explicit opt-in to store the key as plaintext when there is no keystore. */
  allowPlaintext: boolean;
}

export const PLAINTEXT_OPT_IN_ENV = "ARCHYMEDES_ALLOW_PLAINTEXT_KEYS";

/** Linux backends that are not real keyrings: safeStorage then obfuscates with a fixed key. */
const NO_KEYRING_BACKENDS = new Set(["basic_text", "unknown"]);

export function keyStorageFromSafeStorage(
  safe: SafeStorageLike,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): KeyStorage {
  let usable = safe.isEncryptionAvailable();
  if (usable && platform === "linux" && safe.getSelectedStorageBackend) {
    usable = !NO_KEYRING_BACKENDS.has(safe.getSelectedStorageBackend());
  }
  return { cipher: usable ? safe : null, allowPlaintext: env[PLAINTEXT_OPT_IN_ENV] === "1" };
}

export const KEY_ENCRYPTION_UNAVAILABLE_MESSAGE =
  "Can't store the API key securely: no OS keyring is available to encrypt it (on Linux, install and unlock " +
  "gnome-keyring/libsecret or KWallet). The key was not saved. To store it as plaintext instead, restart " +
  `Archymedes Desktop with ${PLAINTEXT_OPT_IN_ENV}=1.`;

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

function decryptKey(encrypted: unknown, storage: KeyStorage): string {
  if (typeof encrypted !== "string" || !storage.cipher) return "";
  try {
    return storage.cipher.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    // A different user/keyring, or a corrupt value: the user re-enters the key.
    return "";
  }
}

export async function loadSettings(userDataPath: string, storage: KeyStorage): Promise<ProviderSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsFile(userDataPath), "utf8");
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
  let settings: ProviderSettings;
  let encrypted: unknown;
  try {
    const { apiKeyEncrypted, ...rest } = JSON.parse(raw) as { apiKeyEncrypted?: unknown };
    encrypted = apiKeyEncrypted;
    // Defaults fill fields an older file lacks; the guard rejects anything malformed.
    settings = providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, ...rest }, "settings");
  } catch {
    return { ...DEFAULT_PROVIDER_SETTINGS };
  }
  if (encrypted !== undefined) {
    // A file with a stored key predates no migration, and a key that can't be decrypted here
    // must not read as "keyless" and switch the user's provider.
    return repairMisplacedKey({ ...settings, apiKey: decryptKey(encrypted, storage) });
  }
  settings = migrateSettings(settings);
  // A key still on disk as plaintext (older builds) moves into the keystore now.
  if (settings.apiKey && storage.cipher) {
    await saveSettings(userDataPath, settings, storage).catch(() => undefined);
  }
  return settings;
}

export async function saveSettings(userDataPath: string, settings: ProviderSettings, storage: KeyStorage): Promise<void> {
  settings = repairMisplacedKey(settings);
  let onDisk: ProviderSettings & { apiKeyEncrypted?: string } = settings;
  if (settings.apiKey) {
    if (storage.cipher) {
      onDisk = { ...settings, apiKey: "", apiKeyEncrypted: storage.cipher.encryptString(settings.apiKey).toString("base64") };
    } else if (!storage.allowPlaintext) {
      // Fail closed: never fall back to writing the secret in the clear without consent.
      throw new Error(KEY_ENCRYPTION_UNAVAILABLE_MESSAGE);
    }
  }
  const file = settingsFile(userDataPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated settings file.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
}
