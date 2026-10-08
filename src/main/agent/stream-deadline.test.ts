import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamDeadline, StreamTimeoutError } from "./stream-deadline";

const options = { firstByteMs: 1_000, idleMs: 500, totalMs: 5_000 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("stream deadline", () => {
  it("aborts when nothing arrives before the first-byte deadline", () => {
    const deadline = createStreamDeadline(new AbortController().signal, options);
    vi.advanceTimersByTime(999);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBeInstanceOf(StreamTimeoutError);
    expect(deadline.timedOut()?.kind).toBe("first-byte");
  });

  it("switches to the idle deadline after the first chunk and resets it on every chunk", () => {
    const deadline = createStreamDeadline(new AbortController().signal, options);
    vi.advanceTimersByTime(900);
    deadline.touch();
    // Past the first-byte deadline, but streaming: only idleness counts now.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(400);
      deadline.touch();
    }
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(500);
    expect(deadline.timedOut()?.kind).toBe("idle");
  });

  it("caps the whole request even while chunks keep arriving", () => {
    const deadline = createStreamDeadline(new AbortController().signal, options);
    for (let elapsed = 0; elapsed < 4_900; elapsed += 100) {
      vi.advanceTimersByTime(100);
      deadline.touch();
    }
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(deadline.timedOut()?.kind).toBe("total");
  });

  it("follows the caller's abort without reporting a timeout", () => {
    const parent = new AbortController();
    const deadline = createStreamDeadline(parent.signal, options);
    parent.abort();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBeUndefined();
    const original = new Error("aborted");
    expect(() => deadline.rethrow(original)).toThrow(original);
  });

  it("is already aborted when the caller's signal was", () => {
    const parent = new AbortController();
    parent.abort();
    expect(createStreamDeadline(parent.signal, options).signal.aborted).toBe(true);
  });

  it("rethrows the SDK's abort error as the timeout that caused it", () => {
    const deadline = createStreamDeadline(new AbortController().signal, options);
    vi.advanceTimersByTime(1_000);
    expect(() => deadline.rethrow(new Error("Request was aborted."))).toThrow(/did not start responding within 1s/);
  });

  it("stops every timer once disposed", () => {
    const deadline = createStreamDeadline(new AbortController().signal, options);
    deadline.dispose();
    deadline.touch();
    vi.advanceTimersByTime(10_000);
    expect(deadline.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
