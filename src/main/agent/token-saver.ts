import type { ProviderId } from "../../shared/types";
import type { RuntimeTurn } from "./adapter";

/**
 * Token saver: keeps what each request re-sends small. Every loop iteration replays the whole
 * conversation, so a long chat with big tool results burns a free daily allowance in a few turns.
 * Three pure steps, applied by runner.ts:
 * - tool results (and bulky tool arguments) from earlier runs become short stubs; the model can
 *   re-run a tool when it needs the output again,
 * - tool output and @mention file contents are capped lower,
 * - the oldest whole exchanges are dropped to fit a token budget, never splitting a tool call
 *   from its result, and never touching the current run.
 * On by default only for free mode, where the allowance is the scarce thing.
 */

export interface TokenSaverOptions {
  /** Max characters of one tool result the model sees in the current run. */
  toolOutputChars: number;
  /** Max characters of one @mentioned file expanded into the prompt. */
  mentionChars: number;
  /** Upper bound of the history budget, in estimated tokens. */
  maxHistoryTokens: number;
  /** Share of the model's context window the history may use, when smaller than the bound. */
  contextShare: number;
}

export const FREE_TOKEN_SAVER: TokenSaverOptions = {
  toolOutputChars: 6_000,
  mentionChars: 12_000,
  maxHistoryTokens: 16_000,
  contextShare: 0.6,
};

/** The saver settings for a provider, or null when requests are sent in full. */
export function tokenSaverFor(provider: ProviderId): TokenSaverOptions | null {
  return provider === "free" ? FREE_TOKEN_SAVER : null;
}

export const EARLIER_TOOL_RESULT_STUB = "[earlier tool result omitted to save tokens — re-run the tool if needed]";
/** Arguments are kept as valid JSON so every provider still accepts the replayed call. */
export const EARLIER_TOOL_ARGS_STUB = JSON.stringify({ omitted: "earlier arguments omitted to save tokens" });
/** Earlier tool arguments longer than this (e.g. a whole write_file body) are stubbed. */
const MAX_EARLIER_ARGS_CHARS = 1_000;

/** A rough, provider-neutral estimate: about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function turnTokens(turn: RuntimeTurn): number {
  switch (turn.kind) {
    case "text":
      return estimateTokens(turn.text);
    case "assistant-toolcalls":
      return estimateTokens(turn.text) + turn.calls.reduce((sum, c) => sum + estimateTokens(c.name) + estimateTokens(c.args), 0);
    case "tool-results":
      return turn.results.reduce((sum, r) => sum + estimateTokens(r.result), 0);
  }
}

/** Cuts `text` to `max` characters with a note that says how much was dropped. */
export function capText(text: string, max: number, what = "output"): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${what} truncated at ${max} of ${text.length} chars to save tokens]`;
}

/**
 * Where the current run starts in turns built from history: the last user message. Everything
 * before it belongs to earlier runs; the runner appends this run's turns after it.
 */
export function currentRunStart(turns: readonly RuntimeTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.kind === "text" && turn.role === "user") return i;
  }
  return turns.length;
}

/**
 * Replaces tool results (and bulky arguments) before `runStart` with stubs. Call ids, names and
 * the call/result pairing are kept, so the replayed history stays valid for every API.
 */
export function stubEarlierToolResults(turns: readonly RuntimeTurn[], runStart: number): RuntimeTurn[] {
  return turns.map((turn, index) => {
    if (index >= runStart) return turn;
    if (turn.kind === "tool-results") {
      return {
        kind: "tool-results",
        results: turn.results.map((r) =>
          r.result.length <= EARLIER_TOOL_RESULT_STUB.length ? r : { ...r, result: EARLIER_TOOL_RESULT_STUB },
        ),
      };
    }
    if (turn.kind === "assistant-toolcalls") {
      return {
        ...turn,
        calls: turn.calls.map((c) => (c.args.length <= MAX_EARLIER_ARGS_CHARS ? c : { ...c, args: EARLIER_TOOL_ARGS_STUB })),
      };
    }
    return turn;
  });
}

/** The history budget in estimated tokens for a model window (0 = unknown window). */
export function historyBudget(contextLimit: number, options: TokenSaverOptions): number {
  const share = contextLimit > 0 ? Math.floor(contextLimit * options.contextShare) : options.maxHistoryTokens;
  return Math.min(options.maxHistoryTokens, share);
}

export function omittedNote(count: number): string {
  return `[${count} earlier message${count === 1 ? "" : "s"} omitted to save tokens]`;
}

/**
 * Drops the oldest earlier exchanges until the request fits `budget` estimated tokens. An exchange
 * starts at a user message and runs to the next one, so a tool call always leaves with its result.
 * The system prompt and the current run (from `runStart`) are always kept, even over budget. When
 * anything is dropped a one-line note takes its place.
 */
export function trimToBudget(
  systemPrompt: string,
  turns: readonly RuntimeTurn[],
  runStart: number,
  budget: number,
): { turns: RuntimeTurn[]; omitted: number } {
  const earlier = turns.slice(0, runStart);
  const current = turns.slice(runStart);
  const fixed = estimateTokens(systemPrompt) + current.reduce((sum, t) => sum + turnTokens(t), 0);

  const exchanges: RuntimeTurn[][] = [];
  for (const turn of earlier) {
    if (exchanges.length === 0 || (turn.kind === "text" && turn.role === "user")) exchanges.push([]);
    exchanges[exchanges.length - 1].push(turn);
  }
  const sizes = exchanges.map((exchange) => exchange.reduce((sum, t) => sum + turnTokens(t), 0));
  let total = fixed + sizes.reduce((sum, n) => sum + n, 0);

  let dropped = 0;
  let omitted = 0;
  while (dropped < exchanges.length && total > budget) {
    total -= sizes[dropped];
    omitted += exchanges[dropped].length;
    dropped += 1;
  }
  if (dropped === 0) return { turns: [...turns], omitted: 0 };

  const note: RuntimeTurn = { kind: "text", role: "user", text: omittedNote(omitted) };
  return { turns: [note, ...exchanges.slice(dropped).flat(), ...current], omitted };
}
