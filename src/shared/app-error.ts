/**
 * The one error model shared by the main process and the renderer.
 *
 * Electron's contextBridge copies a thrown error's message but drops custom
 * properties, so a structured error crosses IPC as a tagged JSON payload inside
 * the message. This module owns both ends of that encoding.
 */

export type AppErrorCode = "no-api-key" | "no-workspace" | "invalid-argument" | "iteration-limit";

export type AppErrorParams = Record<string, string | number>;

export interface AppErrorInfo {
  code?: AppErrorCode;
  /** Untranslated detail; shown when there is no code, and useful in logs. */
  message: string;
  params?: AppErrorParams;
}

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly params?: AppErrorParams,
  ) {
    super(message);
    this.name = "AppError";
  }
}

const TAG = "ARCHYMEDES_APP_ERROR:";
const CODES: ReadonlySet<string> = new Set<AppErrorCode>(["no-api-key", "no-workspace", "invalid-argument", "iteration-limit"]);

/** An Error safe to throw across IPC: AppErrors keep their code, others keep their message. */
export function toTransportError(error: unknown): Error {
  if (error instanceof AppError) {
    return new Error(TAG + JSON.stringify({ code: error.code, message: error.message, params: error.params }));
  }
  return error instanceof Error ? error : new Error(String(error));
}

// Electron prefixes rejected invokes with "Error invoking remote method 'x': Error: ".
const ELECTRON_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

/** Recover the structured error from anything the renderer caught. */
export function parseAppError(error: unknown): AppErrorInfo {
  const raw = error instanceof Error ? error.message : String(error);
  const tagged = raw.indexOf(TAG);
  if (tagged !== -1) {
    try {
      const payload = JSON.parse(raw.slice(tagged + TAG.length)) as Partial<AppErrorInfo>;
      if (typeof payload.code === "string" && CODES.has(payload.code) && typeof payload.message === "string") {
        return { code: payload.code, message: payload.message, params: payload.params };
      }
    } catch {
      // Not our payload after all; fall through to the plain message.
    }
  }
  return { message: raw.replace(ELECTRON_PREFIX, "") };
}
