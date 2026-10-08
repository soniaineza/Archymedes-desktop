import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ProviderSettings } from "../../shared/types";
import { budgetsFor } from "../core/model-capabilities";
import { PROVIDER_INFO } from "../../shared/providers";
import { FreeAdapter } from "./free-adapter";
import { CloudAdapter, cloudOptionsFrom } from "./cloud-adapter";
import { createStreamDeadline, SDK_MAX_RETRIES } from "./stream-deadline";
import type { StreamDeadlineOptions } from "./stream-deadline";
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

// ------------------------------------------------------------ Client cache

/**
 * SDK clients hold connection pools; rebuilding one per turn throws them away. Clients are keyed
 * by everything baked into them, so a settings change still gets a fresh client.
 */
const MAX_CACHED_CLIENTS = 8;
const clientCache = new Map<string, unknown>();

function cachedClient<T>(parts: readonly string[], build: () => T): T {
  const key = JSON.stringify(parts);
  const hit = clientCache.get(key) as T | undefined;
  if (hit !== undefined) {
    // Refresh recency for the small LRU.
    clientCache.delete(key);
    clientCache.set(key, hit);
    return hit;
  }
  const client = build();
  clientCache.set(key, client);
  if (clientCache.size > MAX_CACHED_CLIENTS) {
    const oldest = clientCache.keys().next().value;
    if (oldest !== undefined) clientCache.delete(oldest);
  }
  return client;
}

/** Test hook: drop cached SDK clients. */
export function resetClientCache(): void {
  clientCache.clear();
}

export function anthropicClient(apiKey: string, baseUrl: string): Anthropic {
  return cachedClient(["anthropic", apiKey, baseUrl], () =>
    new Anthropic({ apiKey, baseURL: baseUrl || undefined, maxRetries: SDK_MAX_RETRIES }),
  );
}

export function openAIClient(provider: string, apiKey: string, baseUrl: string, defaultHeaders: Record<string, string> = {}): OpenAI {
  return cachedClient(["openai", provider, apiKey, baseUrl, JSON.stringify(defaultHeaders)], () =>
    new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: SDK_MAX_RETRIES, ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}) }),
  );
}

/**
 * OpenRouter's optional attribution headers (port of the CLI's `openrouter-agent.ts`): never a
 * credential, they only let the app appear on OpenRouter's rankings. `HTTP-Referer` is sent only
 * when OPENROUTER_HTTP_REFERER is set; `X-Title` defaults to the app's name.
 */
export function openRouterHeaders(environment: Record<string, string | undefined> = process.env): Record<string, string> {
  const referer = environment.OPENROUTER_HTTP_REFERER?.trim();
  return {
    ...(referer ? { "HTTP-Referer": referer } : {}),
    "X-Title": environment.OPENROUTER_APP_TITLE?.trim() || "Archymedes Desktop",
  };
}

/** The CLI's OpenRouter error hints, keeping the HTTP status on the error. */
export function openRouterError(error: unknown): Error {
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  if (status === undefined) return error instanceof Error ? error : new Error(String(error));
  const hint =
    status === 401 ? "OpenRouter rejected the key. Update the API key in Settings."
      : status === 402 ? "OpenRouter account quota or key budget is exhausted. Check the key limits."
        : status === 403 ? "OpenRouter refused this model for this key. Choose another model in Settings."
          : status === 429 ? "OpenRouter rate limit reached. Wait before retrying."
            : status === 404 ? "This OpenRouter model is unavailable. Refresh the model list in Settings."
              : `OpenRouter request failed (HTTP ${status}).`;
  return Object.assign(new Error(hint), { status, cause: error });
}

/** Per-request tuning: stream deadlines, and how many retries the SDK may make on its own. */
export interface RequestTuning {
  deadline?: Partial<StreamDeadlineOptions>;
  maxRetries?: number;
  /** Extra request headers, e.g. the free gateway's install token. */
  headers?: Record<string, string>;
  /** Called with the response headers once the stream opens, e.g. to read the install-token status. */
  onResponseHeaders?: (headers: Headers) => void;
}

// ---------------------------------------------------------------- Anthropic

class AnthropicAdapter implements AgentAdapter {
  readonly name = "anthropic";

  constructor(private settings: ProviderSettings, private tuning: RequestTuning = {}) {}

  async runTurn(input: {
    systemPrompt: string;
    turns: RuntimeTurn[];
    tools: ToolSchema[];
    onEvent: (event: AdapterEvent) => void;
    signal: AbortSignal;
  }): Promise<void> {
    const client = anthropicClient(this.settings.apiKey, this.settings.baseUrl);

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

    const deadline = createStreamDeadline(input.signal, this.tuning.deadline);
    try {
      await this.stream(client, messages, input, deadline);
    } catch (error) {
      deadline.rethrow(error);
    } finally {
      deadline.dispose();
    }
  }

  private async stream(
    client: Anthropic,
    messages: Anthropic.MessageParam[],
    input: { systemPrompt: string; tools: ToolSchema[]; onEvent: (event: AdapterEvent) => void },
    deadline: ReturnType<typeof createStreamDeadline>,
  ): Promise<void> {
    const firstByteMs = this.tuning.deadline?.firstByteMs;
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
    }, { signal: deadline.signal, maxRetries: this.tuning.maxRetries ?? SDK_MAX_RETRIES, ...(firstByteMs ? { timeout: firstByteMs } : {}) });

    wireAbort(stream, deadline.signal);

    stream.on("streamEvent", () => deadline.touch());
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

export class OpenAICompatAdapter implements AgentAdapter {
  readonly name = "openai-compatible";

  /** `extraBody` lets free mode add its price cap and output limit without a second streaming loop. */
  constructor(
    private settings: ProviderSettings,
    private extraBody: Record<string, unknown> = {},
    private tuning: RequestTuning = {},
    /** Sent on every request by the SDK client, e.g. OpenRouter's attribution headers. */
    private defaultHeaders: Record<string, string> = {},
  ) {}

  async runTurn(input: {
    systemPrompt: string;
    turns: RuntimeTurn[];
    tools: ToolSchema[];
    onEvent: (event: AdapterEvent) => void;
    signal: AbortSignal;
  }): Promise<void> {
    const client = openAIClient(
      this.settings.provider,
      // Keyless providers (Ollama) ignore the key, but the SDK refuses an empty one.
      this.settings.apiKey || "not-required",
      this.settings.baseUrl || PROVIDER_INFO[this.settings.provider]?.defaultBaseUrl || "",
      this.defaultHeaders,
    );

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

    const deadline = createStreamDeadline(input.signal, this.tuning.deadline);
    try {
      await this.stream(client, messages, input, deadline);
    } catch (error) {
      deadline.rethrow(error);
    } finally {
      deadline.dispose();
    }
  }

  private async stream(
    client: OpenAI,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    input: { tools: ToolSchema[]; onEvent: (event: AdapterEvent) => void; signal: AbortSignal },
    deadline: ReturnType<typeof createStreamDeadline>,
  ): Promise<void> {
    const firstByteMs = this.tuning.deadline?.firstByteMs;
    const { data: stream, response } = await client.chat.completions.create({
      ...(this.extraBody as object),
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
    }, { signal: deadline.signal, maxRetries: this.tuning.maxRetries ?? SDK_MAX_RETRIES, ...(firstByteMs ? { timeout: firstByteMs } : {}), ...(this.tuning.headers ? { headers: this.tuning.headers } : {}) }).withResponse();
    this.tuning.onResponseHeaders?.(response.headers);

    const toolAccum = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let usageTokens = { input: 0, output: 0, cached: 0 };
    let finished = false;

    for await (const chunk of stream) {
      deadline.touch();
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
          // Some OpenAI-compatible hosts send the arguments as an object rather than a JSON string.
          const args: unknown = tc.function?.arguments;
          if (typeof args === "string") existing.args += args;
          else if (args && typeof args === "object") existing.args += JSON.stringify(args);
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

/**
 * OpenRouter with the user's own key, any model, no zero-price cap: the OpenAI-compatible adapter
 * plus attribution headers and OpenRouter's own error hints (CLI `openrouter-agent.ts`).
 */
export class OpenRouterAdapter implements AgentAdapter {
  readonly name = "openrouter";
  private readonly inner: OpenAICompatAdapter;

  constructor(settings: ProviderSettings, environment: Record<string, string | undefined> = process.env) {
    if (!settings.apiKey.trim()) throw new Error("OpenRouter needs an API key (OPENROUTER_API_KEY). Add it in Settings.");
    this.inner = new OpenAICompatAdapter(
      { ...settings, model: settings.model.trim() || PROVIDER_INFO.openrouter.defaultModel, baseUrl: settings.baseUrl.trim() || PROVIDER_INFO.openrouter.defaultBaseUrl! },
      {},
      {},
      openRouterHeaders(environment),
    );
  }

  async runTurn(input: Parameters<AgentAdapter["runTurn"]>[0]): Promise<void> {
    try {
      await this.inner.runTurn(input);
    } catch (error) {
      if (input.signal.aborted) throw error;
      throw openRouterError(error);
    }
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
  if (settings.provider === "free") {
    return new FreeAdapter(settings, {
      inner: (attempt, extraBody, tuning) => new OpenAICompatAdapter(attempt, extraBody, tuning),
    });
  }
  if (settings.provider === "anthropic") {
    return new AnthropicAdapter(settings);
  }
  if (settings.provider === "archymedes-cloud") {
    return new CloudAdapter(cloudOptionsFrom(settings));
  }
  if (settings.provider === "openrouter") {
    return new OpenRouterAdapter(settings);
  }
  return new OpenAICompatAdapter(settings);
}
