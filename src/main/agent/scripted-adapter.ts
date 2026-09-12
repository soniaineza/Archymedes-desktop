import type { AgentAdapter, RuntimeTurn, ToolInvocation } from "./adapter";

/** One model response, played back in order. */
export interface ScriptedTurn {
  text?: string;
  calls?: ToolInvocation[];
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Defaults to "tool-use" when the turn has calls, otherwise "end-turn". */
  stop?: "tool-use" | "end-turn" | "error";
  errorMessage?: string;
  /** Holds the turn open after its text until this settles, so a test can cancel mid-response. */
  holdUntil?: Promise<void>;
}

export interface ScriptedAdapter extends AgentAdapter {
  /** A snapshot of the conversation the runner sent on each request. */
  readonly requests: RuntimeTurn[][];
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * A deterministic stand-in for a model provider, so the real tool loop can be
 * tested end to end without network access. Like the real SDKs, it rejects when
 * the run is aborted mid-response.
 */
export function createScriptedAdapter(script: ScriptedTurn[]): ScriptedAdapter {
  const requests: RuntimeTurn[][] = [];
  return {
    name: "scripted",
    requests,
    async runTurn({ turns, onEvent, signal }) {
      requests.push(structuredClone(turns));
      const turn = script[requests.length - 1];
      if (!turn) throw new Error(`Scripted model ran out of turns after ${script.length}`);

      for (const chunk of turn.text?.match(/[\s\S]{1,8}/g) ?? []) onEvent({ type: "text-delta", delta: chunk });
      if (turn.holdUntil) await Promise.race([turn.holdUntil, whenAborted(signal)]);
      for (const invocation of turn.calls ?? []) onEvent({ type: "tool-call", invocation });
      if (turn.usage) onEvent({ type: "usage", ...turn.usage });
      onEvent({
        type: "finish",
        stopReason: turn.stop ?? (turn.calls?.length ? "tool-use" : "end-turn"),
        errorMessage: turn.errorMessage,
      });
    },
  };
}
