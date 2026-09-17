import type { AgentEvent, ChatMessage, CostInfo, ProviderSettings } from "../../shared/types";
import { historyToTurns } from "./adapter";
import type { AgentAdapter, HistoryToolResult, RuntimeTurn, ToolInvocation } from "./adapter";
import { AGENT_TOOLS, executeTool } from "./tools";
import type { ToolExecutor } from "./tools";
import { readFileForEditor } from "../fs-ui";
import { listFilesFallback } from "../core/workspace-bridge";
import { catalogPricesOf } from "../core/price-lookup";
import { budgetsFor } from "../core/model-capabilities";
import { priceUsage, convertMoney, addMoney, money } from "../core/money";

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

export function systemPromptFor(responseLanguage: string): string {
  const language = responseLanguage.trim();
  const rule = language
    ? `Always write your replies in ${language}, whatever language the user writes in.`
    : "Reply in the language the user writes in.";
  return `${SYSTEM_PROMPT}\n- ${rule} Keep code, identifiers, file paths and commands unchanged.`;
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

/** Expand @path mentions in the latest user message into explicit file context. */
async function expandMentions(turns: RuntimeTurn[], workspace: string): Promise<void> {
  const lastUser = [...turns].reverse().find((t) => t.kind === "text" && t.role === "user");
  if (!lastUser || lastUser.kind !== "text") return;

  const mentions = parseMentions(lastUser.text);
  if (mentions.length === 0) return;

  const parts: string[] = [];
  for (const mention of mentions) {
    try {
      const entry = await readFileForEditor(workspace, mention);
      parts.push(`Contents of @${mention}:\n\n\`\`\`\n${entry.content}\n\`\`\``);
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

    let iteration = 0;
    // Tracks the assistant message the UI is currently rendering. If the
    // adapter throws mid-stream, the catch still closes it — otherwise the
    // renderer shows a pending spinner forever.
    let openMessageId: string | null = null;
    this.emit({ type: "status", status: "thinking" });

    try {
      const adapter = this.deps.createAdapter(this.settings);
      const turns: RuntimeTurn[] = historyToTurns(history);
      await expandMentions(turns, this.workspace);

      while (iteration < this.settings.maxIterations) {
        if (this.controller.signal.aborted) break;
        iteration += 1;
        this.emit({ type: "status", status: "awaiting-model" });

        const calls: ToolInvocation[] = [];
        let assistantText = "";
        let stop: "tool-use" | "end-turn" | "error" = "end-turn";
        let errorMessage: string | undefined;

        const msgId = id("msg");
        openMessageId = msgId;
        this.emit({ type: "message-start", id: msgId });

        await adapter.runTurn({
          systemPrompt: systemPromptFor(this.settings.responseLanguage ?? ""),
          turns,
          tools: AGENT_TOOLS,
          signal: this.controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case "text-delta":
                assistantText += event.delta;
                this.emit({ type: "text-delta", id: msgId, delta: event.delta });
                break;
              case "tool-call":
                calls.push(event.invocation);
                this.emit({
                  type: "tool-start",
                  id: msgId,
                  toolCallId: event.invocation.toolCallId,
                  name: event.invocation.name,
                  args: event.invocation.args,
                });
                this.emit({ type: "status", status: "calling-tool" });
                break;
              case "finish":
                stop = event.stopReason;
                errorMessage = event.errorMessage;
                break;
              case "usage": {
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

        this.emit({ type: "message-end", id: msgId });
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
          results.push({ toolCallId: call.toolCallId, name: call.name, args: call.args, result: output, isError });
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
        this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        this.emit({ type: "status", status: "error" });
      } else {
        this.emit({ type: "status", status: "idle" });
        this.emit({ type: "done" });
      }
    }
  }
}
