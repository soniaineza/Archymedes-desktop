/**
 * Deadlines for one streamed model request. The SDKs' own timeout only covers the wait for
 * response headers (10 minutes by default, retried twice), so a stalled stream could hang a run
 * for half an hour. This aborts a request that:
 * - sends nothing at all within `firstByteMs`,
 * - goes quiet for `idleMs` after it started streaming (reset on every chunk), or
 * - runs longer than `totalMs` overall.
 */

export type StreamTimeoutKind = "first-byte" | "idle" | "total";

export interface StreamDeadlineOptions {
  firstByteMs: number;
  idleMs: number;
  totalMs: number;
}

export const DEFAULT_STREAM_DEADLINE: StreamDeadlineOptions = {
  firstByteMs: 300_000,
  idleMs: 90_000,
  totalMs: 30 * 60_000,
};

/** Retries the SDK may make on its own (connection errors, 429/5xx) before a turn fails. */
export const SDK_MAX_RETRIES = 1;

export class StreamTimeoutError extends Error {
  constructor(readonly kind: StreamTimeoutKind, readonly ms: number) {
    const seconds = Math.round(ms / 1000);
    super(
      kind === "first-byte"
        ? `The model did not start responding within ${seconds}s. Try again, or choose another model.`
        : kind === "idle"
          ? `The model stopped responding for ${seconds}s mid-reply. Try again.`
          : `The model reply took longer than ${Math.round(seconds / 60)} minutes and was stopped.`,
    );
    this.name = "StreamTimeoutError";
  }
}

export interface StreamDeadline {
  /** Aborts when the caller's signal aborts or a deadline passes; hand it to the request. */
  readonly signal: AbortSignal;
  /** Call on every chunk received: marks the first byte and restarts the idle timer. */
  touch(): void;
  /** The timeout that fired, if any. */
  timedOut(): StreamTimeoutError | undefined;
  /** Stop all timers; call when the request settles. */
  dispose(): void;
  /** Rethrows `error` as the timeout that caused it, when one did. */
  rethrow(error: unknown): never;
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createStreamDeadline(
  parent: AbortSignal,
  options: Partial<StreamDeadlineOptions> = {},
  timers: Timers = realTimers,
): StreamDeadline {
  const { firstByteMs, idleMs, totalMs } = { ...DEFAULT_STREAM_DEADLINE, ...options };
  const controller = new AbortController();
  let fired: StreamTimeoutError | undefined;
  let disposed = false;

  const fire = (kind: StreamTimeoutKind, ms: number) => () => {
    if (disposed || controller.signal.aborted) return;
    fired = new StreamTimeoutError(kind, ms);
    dispose();
    controller.abort(fired);
  };

  let phaseTimer = timers.setTimeout(fire("first-byte", firstByteMs), firstByteMs);
  const totalTimer = timers.setTimeout(fire("total", totalMs), totalMs);

  const onParentAbort = (): void => {
    dispose();
    controller.abort(parent.reason);
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    timers.clearTimeout(phaseTimer);
    timers.clearTimeout(totalTimer);
    parent.removeEventListener("abort", onParentAbort);
  }

  if (parent.aborted) onParentAbort();
  else parent.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    touch() {
      if (disposed) return;
      timers.clearTimeout(phaseTimer);
      phaseTimer = timers.setTimeout(fire("idle", idleMs), idleMs);
    },
    timedOut: () => fired,
    dispose,
    rethrow(error: unknown): never {
      if (fired && !parent.aborted) throw fired;
      throw error;
    },
  };
}
