import type { AgentEvent, ChatMessage, CostInfo, ProviderSettings } from "../../shared/types";
import type { ToolInvocation } from "./adapter";
import { historyToTurns } from "./adapter";
import type { HistoryToolResult, RuntimeTurn } from "./adapter";
import { AGENT_TOOLS, executeTool } from "./tools";
import { createAdapter } from "./adapters";
import { readFileEntry } from "../workspace-store";
import { budgetsFor } from "../core/model-capabilities";
import { catalogPricesOf } from "../core/price-lookup";
import { priceUsage, formatMoney, addMoney, money } from "../core/money";
import { PROVIDER_INFO } from "../core/providers";

/**
 * The tool loop, now driven by the CLI core's accounting model: budgets sized
 * from the model's real capabilities, every turn priced through the dated
 * catalog with cached-input discounts, and unpriced models reported honestly.
 */

const SYSTEM_PROMPT = `You are Archymedes, a coding agent working inside the user's workspace.

You have tools to read and write files, edit exact strings, list and glob files, grep contents, and run bounded shell commands inside the workspace.

Guidelines:
- Explore before editing: use list_dir/glob_files and read_file to understand relevant code first.
- Prefer edit_file over write_file for changing part of an existing file — an exact string replacement is safer than a rewrite.
- After significant changes, run builds/tests with run_command and report results honestly.
- Paths are workspace-relative with forward slashes.
- Be concise in your final answer: what changed, why, and what the user should do next.`;

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Expand @path mentions in the latest user message into explicit file context. */
async function expandMentions(turns: RuntimeTurn[]): Promise<void> {
  const lastUser = [...turns].reverse().find((t) => t.kind === "text" && t.role === "user");
  if (!lastUser || lastUser.kind !== "text") return;

  const mentions = [...lastUser.text.matchAll(/@([\w./-]+)/g)].map((m) => m[1]);
  if (mentions.length === 0) return;

  const parts: string[] = [];
  for (const mention of mentions) {
    try {
      const entry = await readFileEntry(mention);
      parts.push(`Contents of @${mention}:\n\n\`\`\`\n${entry.content}\n\`\`\``);
    } catch {
      parts.push(`@${mention}: (file not found or unreadable)`);
    }
  }
  turns.push({ kind: "text", role: "user", text: parts.join("\n\n") });
}

export class AgentRunner {
  private controller = new AbortController();

  constructor(
    private settings: ProviderSettings,
    private workspace: string,
    private emit: (event: AgentEvent) => void,
  ) {}

  cancel(): void {
    this.controller.abort();
  }

  async run(history: ChatMessage[]): Promise<void> {
    this.controller = new AbortController();

    const adapter = createAdapter(this.settings);
    const turns: RuntimeTurn[] = historyToTurns(history);
    await expandMentions(turns);

    // Budgets sized from the model's real capabilities (CLI core).
    const { contextLimit } = budgetsFor(this.settings.model);
    void contextLimit;

    // Prices from the dated catalog; unpriced providers report honestly.
    const prices = catalogPricesOf(this.settings.provider, this.settings.model);
    const totals = { input: 0, output: 0, cached: 0, cost: money(0, this.settings.currency) };

    const emitCost = () => {
      const info: CostInfo = {
        inputTokens: totals.input,
        outputTokens: totals.output,
        cachedInputTokens: totals.cached,
        formatted: formatMoney(totals.cost),
        unpriced: !prices,
      };
      this.emit({ type: "cost", cost: info });
    };

    let iteration = 0;
    this.emit({ type: "status", status: "thinking" });

    try {
      while (iteration < this.settings.maxIterations) {
        if (this.controller.signal.aborted) break;
        iteration += 1;
        this.emit({ type: "status", status: "awaiting-model" });

        const calls: ToolInvocation[] = [];
        let assistantText = "";
        let stop: "tool-use" | "end-turn" | "error" = "end-turn";
        let errorMessage: string | undefined;

        const msgId = id("msg");
        this.emit({ type: "message-start", id: msgId });

        await adapter.runTurn({
          systemPrompt: SYSTEM_PROMPT,
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
                // Price with the catalog (cached-input aware), not flat rates.
                totals.input += event.inputTokens;
                totals.output += event.outputTokens;
                totals.cached += event.cachedInputTokens ?? 0;
                if (prices) {
                  const turnCost = priceUsage(
                    {
                      inputTokens: event.inputTokens,
                      outputTokens: event.outputTokens,
                      cachedInputTokens: event.cachedInputTokens,
                    },
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

        if (assistantText.trim().length > 0) {
          turns.push({ kind: "text", role: "assistant", text: assistantText });
        }
        turns.push({ kind: "assistant-toolcalls", text: assistantText, calls });

        const results: HistoryToolResult[] = [];
        for (const call of calls) {
          if (this.controller.signal.aborted) break;
          const result = await executeTool(call.name, call.args, this.workspace);
          const isError = result.startsWith("Error");
          results.push({
            toolCallId: call.toolCallId,
            name: call.name,
            args: call.args,
            result,
            isError,
          });
          this.emit({
            type: "tool-result",
            toolCallId: call.toolCallId,
            result,
            isError,
          });
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
        });
        this.emit({ type: "status", status: "error" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.controller.signal.aborted) {
        this.emit({ type: "error", message });
        this.emit({ type: "status", status: "error" });
      } else {
        this.emit({ type: "status", status: "idle" });
        this.emit({ type: "done" });
      }
    }
  }
}

/** Label used in the chat header, from the CLI's provider registry. */
export function providerLabel(settings: ProviderSettings): string {
  return `${PROVIDER_INFO[settings.provider]?.label ?? settings.provider} · ${settings.model}`;
}
