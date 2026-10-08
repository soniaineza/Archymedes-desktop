/**
 * The anonymous install token for the hosted free gateway (`POST /v1/install`), mirroring the CLI's
 * `free-install.ts`. It only identifies "this installation" with a random id so the gateway can apply
 * per-install limits instead of the tighter per-address ones.
 *
 * It is optional: every failure (no network, a 429 issuance limit, a 503 from a gateway with tokens
 * disabled, a corrupt file) means "send no token", never an error, and getting one never holds a
 * request up for more than `FREE_INSTALL_TIMEOUT_MS`. Only the gateway path uses it; a user's own
 * OpenRouter key goes direct and never triggers issuance. The token is kept in the app's userData.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const FREE_INSTALL_HEADER = "x-archymedes-install";
export const FREE_INSTALL_STATUS_HEADER = "x-archymedes-install-status";
/** The longest a request ever waits for a token before going ahead without one. */
export const FREE_INSTALL_TIMEOUT_MS = 5_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const FILE_NAME = "free-install.json";

export type StoredInstall = { gateway: string; token: string; install_id?: string; issued_at?: string };
export type FreeInstallStore = {
  read(): Promise<StoredInstall | undefined>;
  write(value: StoredInstall): Promise<void>;
  clear(): Promise<void>;
};
export type FreeInstallFetch = (url: string, init: { method: string; signal: AbortSignal; redirect: RequestRedirect; headers: Record<string, string> }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>;
}>;

/** Header-safe and bounded: anything else from the gateway or the file is ignored. */
function tokenOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value) ? value : undefined;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 ? value : undefined;
}

/** A JSON file readable only by its owner (mode 0600 where supported), replaced atomically. */
export function fileFreeInstallStore(file: string | (() => Promise<string | undefined>)): FreeInstallStore {
  const resolve = async () => (typeof file === "string" ? file : await file());
  return {
    async read() {
      try {
        const target = await resolve();
        if (!target) return undefined;
        const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
        const token = tokenOf(parsed?.token);
        const gateway = label(parsed?.gateway);
        if (!token || !gateway) return undefined;
        return {
          gateway, token,
          ...(label(parsed.install_id) ? { install_id: label(parsed.install_id) } : {}),
          ...(label(parsed.issued_at) ? { issued_at: label(parsed.issued_at) } : {}),
        };
      } catch {
        return undefined;
      }
    },
    async write(value) {
      const target = await resolve();
      if (!target) return;
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      await fs.chmod(target, 0o600).catch(() => undefined);
    },
    async clear() {
      const target = await resolve().catch(() => undefined);
      if (target) await fs.rm(target, { force: true }).catch(() => undefined);
    },
  };
}

/** `<userData>/free-install.json`, or undefined outside Electron (tests, scripts): then nothing is stored. */
export async function userDataInstallFile(): Promise<string | undefined> {
  try {
    const electron = (await import("electron")) as unknown as { app?: { getPath?(name: string): string } };
    const userData = electron.app?.getPath?.("userData");
    return userData ? path.join(userData, FILE_NAME) : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterMs(headers: { get(name: string): string | null }, now: number): number {
  const seconds = Number(headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const reset = Date.parse(headers.get("x-free-reset-utc") ?? "");
  if (Number.isFinite(reset) && reset > now) return Math.min(reset - now, MAX_RETRY_AFTER_MS);
  return RETRY_AFTER_FAILURE_MS;
}

/** Resolves to undefined after `ms` or on abort, whichever is first; never rejects. */
function bounded<T>(work: Promise<T | undefined>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const finish = (value: T | undefined) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(finish, () => finish(undefined));
  });
}

/**
 * One gateway's install token: loaded from the store, else issued once (single-flight) and saved.
 * `observe` reacts to `x-archymedes-install-status`: an `invalid` token is dropped and replaced on the
 * next request, once per app session; a second rejection stops sending tokens for the session.
 */
export class FreeInstallToken {
  private token?: string;
  private loaded = false;
  private pending?: Promise<string | undefined>;
  private retryAt = 0;
  private reissued = false;
  private disabled = false;
  private readonly gateway: string;

  constructor(
    private readonly options: { gatewayUrl: string; store?: FreeInstallStore; fetchImpl?: FreeInstallFetch; timeoutMs?: number; now?: () => number },
  ) {
    this.gateway = options.gatewayUrl.replace(/\/+$/, "");
  }

  /** The token to send right now, without waiting or issuing. */
  current(): string | undefined {
    return this.disabled ? undefined : this.token;
  }

  /** The token, issuing one if needed. Never throws; waits at most the timeout (default 5 s). */
  async get(signal?: AbortSignal): Promise<string | undefined> {
    if (this.disabled) return undefined;
    if (this.token) return this.token;
    this.pending ??= this.load()
      .catch(() => undefined)
      .finally(() => {
        this.pending = undefined;
      });
    return await bounded(this.pending, this.options.timeoutMs ?? FREE_INSTALL_TIMEOUT_MS, signal);
  }

  /** Feed the status header of a response to a request that carried `sent`. */
  observe(status: string | null | undefined, sent: string | undefined): void {
    if (!sent || status?.trim().toLowerCase() !== "invalid" || sent !== this.token) return;
    this.token = undefined;
    void this.options.store?.clear().catch(() => undefined);
    if (this.reissued) {
      this.disabled = true;
      return;
    }
    this.reissued = true;
    this.retryAt = 0;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async load(): Promise<string | undefined> {
    if (!this.loaded) {
      this.loaded = true;
      const stored = await this.options.store?.read().catch(() => undefined);
      // A token from another deployment would only be rejected there.
      if (stored && stored.gateway === this.gateway) return (this.token = stored.token);
    }
    if (this.now() < this.retryAt) return undefined;
    return await this.issue();
  }

  private async issue(): Promise<string | undefined> {
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as FreeInstallFetch);
    try {
      const response = await fetchImpl(`${this.gateway}/v1/install`, {
        method: "POST",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? FREE_INSTALL_TIMEOUT_MS),
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        this.retryAt = this.now() + retryAfterMs(response.headers, this.now());
        return undefined;
      }
      const body = (await response.json()) as Record<string, unknown> | null;
      const token = tokenOf(body?.token);
      if (!token) {
        this.retryAt = this.now() + RETRY_AFTER_FAILURE_MS;
        return undefined;
      }
      this.token = token;
      await this.options.store
        ?.write({
          gateway: this.gateway,
          token,
          ...(label(body?.install_id) ? { install_id: label(body?.install_id) } : {}),
          ...(label(body?.issued_at) ? { issued_at: label(body?.issued_at) } : {}),
        })
        .catch(() => undefined);
      return token;
    } catch {
      this.retryAt = this.now() + RETRY_AFTER_FAILURE_MS;
      return undefined;
    }
  }
}
