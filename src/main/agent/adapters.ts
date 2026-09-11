import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ProviderSettings } from "../../shared/types";
import { budgetsFor } from "../core/model-capabilities";
import { defaultBaseUrl, isProviderId } from "../core/providers";
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

    // Two cache breakpoints: the system block (covers tools + system, which
    // render first) and the newest message block, so each loop iteration
    // reads the whole prior conversation from cache.
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && Array.isArray(lastMessage.content) && lastMessage.content.length > 0) {
      const lastBlock = lastMessage.content[lastMessage.content.length - 1] as {
        cache_control?: Anthropic.CacheControlEphemeral | null;
      };
      lastBlock.cache_control = { type: "ephemeral" };
    }

    const stream = client.messages.stream({
      model: this.settings.model,
      max_tokens: budgetsFor(this.settings.model).maxOutputTokens,
      system: [{ type: "text", text: input.systemPrompt, cache_control: { type: "ephemeral" } }],
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

    // Anthropic's input_tokens excludes cache reads and writes; the core's
    // pricing treats cached tokens as a subset of input, so fold them back in.
    // Cache writes are priced at the base input rate (the API bills 1.25x).
    const cacheRead = finalMessage.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = finalMessage.usage.cache_creation_input_tokens ?? 0;
    input.onEvent({
      type: "usage",
      inputTokens: finalMessage.usage.input_tokens + cacheRead + cacheWrite,
      outputTokens: finalMessage.usage.output_tokens,
      cachedInputTokens: cacheRead,
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
    onEvent: (event: AdapterEvent) => void;
    signal: AbortSignal;
  }): Promise<void> {
    const provider = this.settings.provider;
    const client = new OpenAI({
      // Ollama ignores the key, but the SDK refuses an empty one.
      apiKey: this.settings.apiKey || "ollama",
      baseURL: this.settings.baseUrl || (isProviderId(provider) ? defaultBaseUrl(provider) : undefined),
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
      tools: input.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    }, { signal: input.signal });

    const toolAccum = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let usageTokens = { input: 0, output: 0, cached: 0 };
    let finished = false;

    for await (const chunk of stream) {
      if (input.signal.aborted) break;

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
      // Some OpenAI-compatible hosts (Gemini, Ollama) report finish_reason
      // "stop" even when they emitted tool calls; trust the calls themselves.
      stopReason: finished || toolAccum.size > 0 ? "tool-use" : "end-turn",
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
