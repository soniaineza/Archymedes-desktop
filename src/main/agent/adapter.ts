import type { ChatMessage } from "../../shared/types";

/**
 * The pluggable agent-runtime seam.
 *
 * The desktop app speaks to the model only through this interface, so the
 * CLI's `@archymedes/core` runtime (or any other) can be dropped in later
 * without touching the UI or the tool loop. An adapter turns the neutral
 * message/thread shape into provider calls and streams results back as
 * neutral events.
 */

// ---------- Neutral tool description (provider-shape-agnostic) ----------

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON-schema for the tool's parameters */
  parameters: Record<string, unknown>;
}

export interface ToolInvocation {
  toolCallId: string;
  name: string;
  /** JSON-encoded arguments as received from the model */
  args: string;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
  isError: boolean;
}

// ---------- Neutral stream events ----------

export type AdapterEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; invocation: ToolInvocation }
  | { type: "finish"; stopReason: "tool-use" | "end-turn" | "error"; errorMessage?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number };

// ---------- History entry shapes the adapter consumes ----------

/** A completed tool call with its result, as stored in history. */
export interface HistoryToolResult {
  toolCallId: string;
  name: string;
  args: string;
  result: string;
  isError: boolean;
}

/**
 * Runtime-agnostic conversation turn:
 * - user/system text turn, or
 * - assistant turn that may contain text and/or tool calls, or
 * - tool results following an assistant tool-call turn.
 */
export type RuntimeTurn =
  | { kind: "text"; role: "user" | "system" | "assistant"; text: string }
  | { kind: "assistant-toolcalls"; text: string; calls: ToolInvocation[] }
  | { kind: "tool-results"; results: HistoryToolResult[] };

export function historyToTurns(history: ChatMessage[]): RuntimeTurn[] {
  const turns: RuntimeTurn[] = [];
  for (const msg of history) {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      turns.push({
        kind: "assistant-toolcalls",
        text: msg.content,
        calls: msg.toolCalls.map((tc) => ({
          toolCallId: tc.id,
          name: tc.name,
          args: tc.args,
        })),
      });
      // All results for one assistant turn go back together; splitting them
      // across messages discourages the model from making parallel calls.
      turns.push({
        kind: "tool-results",
        results: msg.toolCalls.map((tc) => ({
          toolCallId: tc.id,
          name: tc.name,
          args: tc.args,
          result: tc.result ?? "(no result)",
          isError: tc.isError ?? false,
        })),
      });
    } else if (msg.content.trim().length > 0) {
      turns.push({ kind: "text", role: msg.role, text: msg.content });
    }
  }
  return turns;
}

// ---------- The adapter contract ----------

export interface AgentAdapter {
  readonly name: string;
  /**
   * Run one model turn. Streams events through `onEvent` and resolves when
   * the turn is finished. The loop in runner.ts decides whether to continue
   * with tool results or stop.
   */
  runTurn(input: {
    systemPrompt: string;
    turns: RuntimeTurn[];
    tools: ToolSchema[];
    onEvent: (event: AdapterEvent) => void;
    signal: AbortSignal;
  }): Promise<void>;
}
