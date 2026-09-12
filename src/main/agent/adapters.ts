import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ProviderSettings } from "../../shared/types";
import type {
  AdapterEvent,
  AgentAdapter,
  RuntimeTurn,
  ToolSchema,
} from "./adapter";

/**
 * Two adapters cover the provider matrix:
 * - Anthropic Messages API (its tool-use shape is unique),
 * - OpenAI Chat Completions, which every OpenAI-compatible host speaks
 *   (OpenAI, Groq, DeepSeek, Mistral, Ollama, OpenRouter, …).
 */

// ---------------------------------------------------------------- Anthropic

class AnthropicAdapter implements AgentAdapter {
  readonly name = "anthropic";

  constructor(private settings: ProviderSettings) {}

  async runTurn(input: {
    systemPrompt: string;
    turns: RuntimeTurn[];
    tools: ToolSchema[];
    maxOutputTokens?: number;
    onEvent: (event: AdapterEvent) => void;
    signal: AbortSignal;
  }): Promise<void> {
    const client = new Anthropic({
      apiKey: this.settings.apiKey,
      baseURL: this.settings.baseUrl || undefined,
    });

    // Convert neutral turns into Anthropic content blocks.
    const messages: Anthropic.MessageParam[] = [];
    for (const turn of input.turns) {
      if (turn.kind === "text") {
        if (turn.role === "system") continue;
        messages.push({
          role: turn.role === "assistant" ? "assistant" : "user",
          content: [{ type: "text", text: turn.text }],
        });
      } else if (turn.kind === "assistant-toolcalls") {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (turn.text.trim()) {
          blocks.push({ type: "text", text: turn.text });
        }
        for (const call of turn.calls) {
          blocks.push({
            type: "tool_use",
            id: call.toolCallId,
            name: call.name,
            input: safeJsonParse(call.args),
          });
        }
        messages.push({ role: "assistant", content: blocks });
      } else {
        messages.push({
          role: "user",
          content: turn.results.map(
            (r): Anthropic.ToolResultBlockParam => ({
              type: "tool_result",
              tool_use_id: r.toolCallId,
              content: r.result,
              is_error: r.isError,
            }),
          ),
        });
      }
    }

    const stream = client.messages.stream({
      model: this.settings.model,
      // Sized from the model's real capabilities (runner passes the budget);
      // 8192 was a blind ceiling that shortchanged large rewrites.
      max_tokens: input.maxOutputTokens ?? 8192,
      system: input.systemPrompt,
      messages,
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
    });

    wireAbort(stream, input.signal);

    stream.on("text", (delta) => {
      input.onEvent({ type: "text-delta", delta });
    });

    const finalMessage = await stream.finalMessage();

    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        input.onEvent({
          type: "tool-call",
          invocation: {
            toolCallId: block.id,
            name: block.name,
            args: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    input.onEvent({
      type: "usage",
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
      // Cache reads are what make a long agent session affordable; the CLI's
      // accounting folds them in so the cost display reflects reality.
      cachedInputTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
    });

    const usedTools = finalMessage.content.some((b) => b.type === "tool_use");
    input.onEvent({
      type: "finish",
      stopReason: usedTools ? "tool-use" : "end-turn",
    });
  }
}

function wireAbort(
  stream: { abort: () => void },
  signal: AbortSignal,
): void {
  const onAbort = (): void => stream.abort();
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
}

// ------------------------------------------------------- OpenAI-compatible

class OpenAICompatAdapter implements AgentAdapter {
  readonly name = "openai-compatible";

  constructor(private settings: ProviderSettings) {}

  async runTurn(input: {
    systemPrompt: string;
    turns: RuntimeTurn[];
    tools: ToolSchema[];
    maxOutputTokens?: number;
    onEvent: (event: AdapterEvent) => void;
    signal: AbortSignal;
  }): Promise<void> {
    const client = new OpenAI({
      apiKey: this.settings.apiKey,
      baseURL: this.settings.baseUrl || undefined,
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: input.systemPrompt },
    ];

    for (const turn of input.turns) {
      if (turn.kind === "text") {
        if (turn.role === "system") continue;
        messages.push({
          role: turn.role,
          content: turn.text,
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      } else if (turn.kind === "assistant-toolcalls") {
        messages.push({
          role: "assistant",
          content: turn.text || null,
          tool_calls: turn.calls.map((c) => ({
            id: c.toolCallId,
            type: "function" as const,
            function: { name: c.name, arguments: c.args },
          })),
        });
      } else {
        for (const r of turn.results) {
          messages.push({
            role: "tool",
            tool_call_id: r.toolCallId,
            content: r.result,
          });
        }
      }
    }

    const stream = await client.chat.completions.create({
      model: this.settings.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // OpenAI-compat hosts vary in what they accept; only send the ceiling
      // when the caller derived one from the model capabilities table.
      ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}),
      tools: input.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    });

    const toolAccum = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let usageTokens = { input: 0, output: 0, cached: 0 };
    let finished = false;

    for await (const chunk of stream) {
      if (input.signal.aborted) {
        // A tool call that was mid-stream when the user hit Stop is flushed as
        // a partial invocation; the runner then feeds a cancelled result back
        // so the next request's tool_calls/tool messages stay paired.
        if (toolAccum.size > 0) {
          for (const [, call] of [...toolAccum.entries()].sort((a, b) => a[0] - b[0])) {
            input.onEvent({
              type: "tool-call",
              invocation: {
                toolCallId: call.id || `call_${Math.random().toString(36).slice(2)}`,
                name: call.name,
                args: call.args || "{}",
              },
            });
          }
        }
        break;
      }

      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        input.onEvent({ type: "text-delta", delta: choice.delta.content });
      }

      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolAccum.get(tc.index) ?? {
            id: "",
            name: "",
            args: "",
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolAccum.set(tc.index, existing);
        }
      }

      if (choice?.finish_reason === "tool_calls") finished = true;
      if (chunk.usage) {
        usageTokens = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          cached: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
    }

    for (const [, call] of [...toolAccum.entries()].sort((a, b) => a[0] - b[0])) {
      input.onEvent({
        type: "tool-call",
        invocation: {
          toolCallId:
            call.id || `call_${Math.random().toString(36).slice(2)}`,
          name: call.name,
          args: call.args || "{}",
        },
      });
    }

    if (usageTokens.input || usageTokens.output) {
      input.onEvent({
        type: "usage",
        inputTokens: usageTokens.input,
        outputTokens: usageTokens.output,
        cachedInputTokens: usageTokens.cached,
      });
    }

    input.onEvent({
      type: "finish",
      stopReason: finished ? "tool-use" : "end-turn",
    });
  }
}

function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createAdapter(settings: ProviderSettings): AgentAdapter {
  if (settings.provider === "anthropic") {
    return new AnthropicAdapter(settings);
  }
  return new OpenAICompatAdapter(settings);
}
