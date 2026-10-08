import type { AgentEvent, ChatMessage, CostInfo, DailyUsage, FreeAllowance, MessageUsage, ProviderSettings } from "../../shared/types";
import { AppError } from "../../shared/app-error";
import { historyToTurns } from "./adapter";
import type { AgentAdapter, HistoryToolResult, RuntimeTurn, ToolInvocation } from "./adapter";
import { AGENT_TOOLS, executeTool } from "./tools";
import { repairToolArgs } from "./tool-args";
import type { ToolExecutor } from "./tools";
import { readFileForEditor } from "../fs-ui";
import { listFilesFallback } from "../core/workspace-bridge";
import { catalogPricesOf } from "../core/price-lookup";
import { budgetsFor } from "../core/model-capabilities";
import { priceUsage, convertMoney, addMoney, money } from "../core/money";
import { capText, currentRunStart, historyBudget, stubEarlierToolResults, tokenSaverFor, trimToBudget } from "./token-saver";

/**
 * The tool loop, driven by the CLI core's accounting model: every turn priced
 * through the dated catalog with cached-input discounts, and unpriced models
 * reported honestly. The model and the snapshot store are injected.
 */

export type AdapterFactory = (settings: ProviderSettings) => AgentAdapter;

export interface RunnerDeps {
  createAdapter: AdapterFactory;
  /** Records a file's content before the agent changes it, for diff and revert. */
  recordSnapshot(workspace: string, relPath: string): Promise<void>;
  executeTool?: ToolExecutor;
  /**
   * Asked before each run_command when settings.commandApproval is "ask". The app always supplies
   * one (see services.ts); tests that omit it run commands directly, as "auto" mode does.
   */
  approveCommand?(call: { toolCallId: string; command: string }, signal: AbortSignal): Promise<boolean>;
  /**
   * Adds one model request's tokens to today's local count, with the free gateway's allowance when
   * it reported one; resolves to the day's totals, which the runner forwards as a daily-usage event.
   */
  recordUsage?(tokens: number, allowance?: FreeAllowance): Promise<Omit<DailyUsage, "provider">>;
}

export const COMMAND_DECLINED = "The user declined to run this command. Do not run it again; explain what you wanted it for or take another approach.";

function commandOf(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || "{}") as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : "";
  } catch {
    return "";
  }
}

const SYSTEM_PROMPT = `You are Archymedes, a coding agent working inside the user's workspace.

You have tools to read and write files, edit exact strings, list and glob files, grep contents, and run bounded shell commands inside the workspace.

Guidelines:
- Explore before editing: use list_dir/glob_files and read_file to understand relevant code first.
- Prefer edit_file over write_file for changing part of an existing file — an exact string replacement is safer than a rewrite.
- After significant changes, run builds/tests with run_command and report results honestly.
- Paths are workspace-relative with forward slashes.
- Be concise in your final answer: what changed, why, and what the user should do next.`;

/**
 * Free models have a small daily request allowance, and every model turn is one request. These
 * rules make each request count; the runner executes every tool call of a turn before the next one.
 */
export const FREE_MODE_GUIDANCE = `Requests are limited in this mode (each of your turns costs one), so make every turn count:
- Batch independent tool calls into one turn: when you need several files, searches or listings, request them all at once instead of one per turn.
- Do not re-read files whose contents are already in this conversation; reuse what you have seen.
- Prefer one focused edit_file call per change over rewriting whole files, and read only the line range you need in large files.
- Stop as soon as the task is done; do not spend a turn on optional checks unless they matter.`;

export function systemPromptFor(responseLanguage: string, options: { frugal?: boolean } = {}): string {
  const language = responseLanguage.trim();
  const rule = language
    ? `Always write your replies in ${language}, whatever language the user writes in.`
    : "Reply in the language the user writes in.";
  const base = `${SYSTEM_PROMPT}\n- ${rule} Keep code, identifiers, file paths and commands unchanged.`;
  return options.frugal ? `${base}\n\n${FREE_MODE_GUIDANCE}` : base;
}

/** What the model is told when its tool arguments could not be read even after repair. */
export function invalidArgsMessage(toolName: string, raw: string): string {
  const shown = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  return `Error: the arguments for ${toolName} were not valid JSON, so the tool did not run. Call ${toolName} again with its arguments as one JSON object with double-quoted keys and strings, for example {"path": "src/index.ts"}. You sent: ${shown}`;
}

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const MAX_MENTION_LISTING = 16_000;

/** @path mentions at a word start (so emails don't match), minus trailing punctuation. */
export function parseMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@([\w./-]+)/g)) {
    const mention = match[1].replace(/[.,;:!?]+$/, "");
    if (mention) found.add(mention);
  }
  return [...found];
}

/**
 * Expand @path mentions in the latest user message into explicit file context. `maxFileChars`
 * (the token saver's mention cap) truncates each file with a note; unset, files go in whole.
 */
async function expandMentions(turns: RuntimeTurn[], workspace: string, maxFileChars?: number): Promise<void> {
  const lastUser = [...turns].reverse().find((t) => t.kind === "text" && t.role === "user");
  if (!lastUser || lastUser.kind !== "text") return;

  const mentions = parseMentions(lastUser.text);
  if (mentions.length === 0) return;

  const parts: string[] = [];
  for (const mention of mentions) {
    try {
      const entry = await readFileForEditor(workspace, mention);
      const content = maxFileChars ? capText(entry.content, maxFileChars, "file") : entry.content;
      parts.push(`Contents of @${mention}:\n\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      try {
        const listing = (await listFilesFallback(workspace, mention)).slice(0, MAX_MENTION_LISTING);
        parts.push(`Files under @${mention}:\n\n\`\`\`\n${listing}\n\`\`\``);
      } catch {
        parts.push(`@${mention}: (file not found or unreadable)`);
      }
    }
  }
  turns.push({ kind: "text", role: "user", text: parts.join("\n\n") });
}

export class AgentRunner {
  private controller = new AbortController();

  constructor(
    private readonly settings: ProviderSettings,
    private readonly workspace: string,
    private readonly emit: (event: AgentEvent) => void,
    private readonly deps: RunnerDeps,
  ) {}

  cancel(): void {
    this.controller.abort();
  }

  async run(history: ChatMessage[]): Promise<void> {
    this.controller = new AbortController();
    const runTool = this.deps.executeTool ?? executeTool;
    const toolContext = {
      workspace: this.workspace,
      recordSnapshot: (relPath: string) => this.deps.recordSnapshot(this.workspace, relPath),
    };

    // Prices from the dated catalog; unpriced providers report honestly.
    // Totals are kept in the catalog's currency: there are no FX rates, and
    // adding e.g. USD prices to a EUR total throws.
    const prices = catalogPricesOf(this.settings.provider, this.settings.model);
    const totals = { input: 0, output: 0, cached: 0, cost: money(0, prices?.currency ?? this.settings.currency) };
    // The last turn's prompt size vs the model's window drives the context meter.
    const { contextLimit } = budgetsFor(this.settings.model);
    let contextTokens = 0;

    const { currency: displayCurrency, exchangeRate } = this.settings;
    const convert = displayCurrency !== totals.cost.currency && exchangeRate > 0;

    const emitCost = () => {
      const shown = convert ? convertMoney(totals.cost, displayCurrency, exchangeRate) : totals.cost;
      const info: CostInfo = {
        inputTokens: totals.input,
        outputTokens: totals.output,
        cachedInputTokens: totals.cached,
        contextTokens,
        contextLimit,
        costMicros: shown.micros,
        currency: shown.currency,
        converted: convert,
        unpriced: !prices,
      };
      this.emit({ type: "cost", cost: info });
    };

    // Free mode's daily allowance is the scarce thing: send less (see token-saver.ts).
    const saver = tokenSaverFor(this.settings.provider);
    const systemPrompt = systemPromptFor(this.settings.responseLanguage ?? "", { frugal: this.settings.provider === "free" });

    // Today's local token count, with the gateway's allowance when it reported one. The header
    // describes the state before the request, so this request's tokens come off it.
    const recordDaily = (tokens: number, allowance?: FreeAllowance, requestDone = false): void => {
      if (!this.deps.recordUsage) return;
      const adjusted = allowance && {
        ...allowance,
        ...(allowance.remainingTokens !== undefined ? { remainingTokens: Math.max(0, allowance.remainingTokens - tokens) } : {}),
        ...(allowance.remainingRequests !== undefined ? { remainingRequests: Math.max(0, allowance.remainingRequests - (requestDone ? 1 : 0)) } : {}),
      };
      void this.deps.recordUsage(tokens, adjusted).then(
        (daily) => this.emit({ type: "daily-usage", usage: { ...daily, provider: this.settings.provider } }),
        () => undefined,
      );
    };

    let iteration = 0;
    // Tracks the assistant message the UI is currently rendering. If the
    // adapter throws mid-stream, the catch still closes it — otherwise the
    // renderer shows a pending spinner forever.
    let openMessageId: string | null = null;
    this.emit({ type: "status", status: "thinking" });

    try {
      const adapter = this.deps.createAdapter(this.settings);
      const replayed = historyToTurns(history);
      // Everything before the last user message is from earlier runs; this run's turns follow it.
      const runStart = currentRunStart(replayed);
      const turns: RuntimeTurn[] = saver ? stubEarlierToolResults(replayed, runStart) : replayed;
      await expandMentions(turns, this.workspace, saver?.mentionChars);
      const budget = saver ? historyBudget(contextLimit, saver) : 0;

      while (iteration < this.settings.maxIterations) {
        if (this.controller.signal.aborted) break;
        iteration += 1;
        this.emit({ type: "status", status: "awaiting-model" });

        const calls: ToolInvocation[] = [];
        /** Tool calls whose arguments could not be repaired, with what the model sent. */
        const unreadable = new Map<string, string>();
        let assistantText = "";
        let stop: "tool-use" | "end-turn" | "error" = "end-turn";
        let errorMessage: string | undefined;
        let retrying = false;
        let turnUsage: MessageUsage | undefined;
        let allowance: FreeAllowance | undefined;

        const msgId = id("msg");
        openMessageId = msgId;
        this.emit({ type: "message-start", id: msgId });

        try {
          await adapter.runTurn({
            systemPrompt,
            // Re-trimmed every iteration: this run's tool results grow the request as it goes.
            turns: saver ? trimToBudget(systemPrompt, turns, runStart, budget).turns : turns,
            tools: AGENT_TOOLS,
            signal: this.controller.signal,
            onEvent: (event) => {
              switch (event.type) {
                case "retry":
                  retrying = true;
                  this.emit({ type: "status", status: "retrying" });
                  break;
                case "text-delta":
                  if (retrying) {
                    retrying = false;
                    this.emit({ type: "status", status: "awaiting-model" });
                  }
                  assistantText += event.delta;
                  this.emit({ type: "text-delta", id: msgId, delta: event.delta });
                  break;
                case "tool-call": {
                  // Weaker (often free) models send almost-JSON; repair it before anything reads it,
                  // and keep valid JSON in the history so the next request is not rejected for it.
                  const repaired = repairToolArgs(event.invocation.args);
                  const invocation = { ...event.invocation, args: repaired.ok ? repaired.json : "{}" };
                  if (!repaired.ok) unreadable.set(invocation.toolCallId, event.invocation.args);
                  calls.push(invocation);
                  this.emit({
                    type: "tool-start",
                    id: msgId,
                    toolCallId: invocation.toolCallId,
                    name: invocation.name,
                    args: repaired.ok ? invocation.args : event.invocation.args,
                  });
                  this.emit({ type: "status", status: "calling-tool" });
                  break;
                }
                case "finish":
                  stop = event.stopReason;
                  errorMessage = event.errorMessage;
                  break;
                case "allowance":
                  allowance = {
                    ...(event.remainingTokens !== undefined ? { remainingTokens: event.remainingTokens } : {}),
                    ...(event.remainingRequests !== undefined ? { remainingRequests: event.remainingRequests } : {}),
                    resetUtc: event.resetUtc,
                    warning: event.warning,
                  };
                  break;
                case "usage": {
                  turnUsage = {
                    inputTokens: (turnUsage?.inputTokens ?? 0) + event.inputTokens,
                    outputTokens: (turnUsage?.outputTokens ?? 0) + event.outputTokens,
                  };
                  recordDaily(event.inputTokens + event.outputTokens, allowance, true);
                  allowance = undefined;
                  totals.input += event.inputTokens;
                  totals.output += event.outputTokens;
                  totals.cached += event.cachedInputTokens ?? 0;
                  contextTokens = event.inputTokens;
                  if (prices) {
                    const turnCost = priceUsage(
                      { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens },
                      prices,
                    );
                    totals.cost = addMoney(totals.cost, turnCost);
                  }
                  emitCost();
                  break;
                }
              }
            },
          });
        } finally {
          // A refused request (e.g. the gateway's 429) still reports the allowance it hit.
          if (allowance) recordDaily(0, allowance);
        }

        this.emit({ type: "message-end", id: msgId, ...(turnUsage ? { usage: turnUsage } : {}) });
        openMessageId = null;

        if (errorMessage) {
          this.emit({ type: "error", message: errorMessage });
          this.emit({ type: "status", status: "error" });
          return;
        }

        // The adapter's onEvent closure assigns `stop` mid-await; defeat TS's
        // control-flow narrowing, which can't see across that boundary.
        const finishReason = stop as "tool-use" | "end-turn" | "error";
        if (finishReason !== "tool-use" || calls.length === 0) {
          this.emit({ type: "status", status: "idle" });
          this.emit({ type: "done" });
          return;
        }

        turns.push({ kind: "assistant-toolcalls", text: assistantText, calls });

        const results: HistoryToolResult[] = [];
        for (const call of calls) {
          if (this.controller.signal.aborted) {
            // Cancelled calls still need a result: honest UI feedback and a
            // consistent turn history if this conversation is ever replayed.
            results.push({ toolCallId: call.toolCallId, name: call.name, args: call.args, result: "(cancelled)", isError: true });
            this.emit({ type: "tool-result", toolCallId: call.toolCallId, result: "(cancelled)", isError: true });
            continue;
          }
          const unreadableArgs = unreadable.get(call.toolCallId);
          if (unreadableArgs !== undefined) {
            // One corrective message back to the model instead of failing the run.
            const result = invalidArgsMessage(call.name, unreadableArgs);
            results.push({ toolCallId: call.toolCallId, name: call.name, args: call.args, result, isError: true });
            this.emit({ type: "tool-result", toolCallId: call.toolCallId, result, isError: true });
            continue;
          }
          if (call.name === "run_command" && this.settings.commandApproval !== "auto" && this.deps.approveCommand) {
            const approved = await this.deps.approveCommand({ toolCallId: call.toolCallId, command: commandOf(call.args) }, this.controller.signal);
            if (!approved) {
              const result = this.controller.signal.aborted ? "(cancelled)" : COMMAND_DECLINED;
              results.push({ toolCallId: call.toolCallId, name: call.name, args: call.args, result, isError: true });
              this.emit({ type: "tool-result", toolCallId: call.toolCallId, result, isError: true });
              continue;
            }
            this.emit({ type: "status", status: "calling-tool" });
          }
          const { output, isError } = await runTool(call.name, call.args, toolContext);
          // The UI keeps the full output; the model sees the token saver's shorter cap.
          const result = saver ? capText(output, saver.toolOutputChars) : output;
          results.push({ toolCallId: call.toolCallId, name: call.name, args: call.args, result, isError });
          this.emit({ type: "tool-result", toolCallId: call.toolCallId, result: output, isError });
        }
        turns.push({ kind: "tool-results", results });
      }

      if (this.controller.signal.aborted) {
        this.emit({ type: "status", status: "idle" });
        this.emit({ type: "done" });
      } else {
        this.emit({
          type: "error",
          message: `Reached the iteration limit (${this.settings.maxIterations}).`,
          code: "iteration-limit",
          params: { count: this.settings.maxIterations },
        });
        this.emit({ type: "status", status: "error" });
      }
    } catch (err) {
      // Close any message the UI still renders as pending before reporting.
      if (openMessageId) {
        this.emit({ type: "message-end", id: openMessageId });
        openMessageId = null;
      }
      if (!this.controller.signal.aborted) {
        if (err instanceof AppError) {
          this.emit({ type: "error", message: err.message, code: err.code, params: err.params });
        } else {
          this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        this.emit({ type: "status", status: "error" });
      } else {
        this.emit({ type: "status", status: "idle" });
        this.emit({ type: "done" });
      }
    }
  }
}
