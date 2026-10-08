/**
 * Archymedes Cloud (the hosted execution exchange) for the desktop app. Port of the CLI's
 * `core/src/providers/archymedes-cloud-agent.ts`: every model call carries a hard spend cap and an
 * idempotency key, and the exchange (not this client) owns routing, provider credentials and
 * settlement. Completions are buffered (`stream: false`) until the exchange has a settlement-safe
 * stream, so text arrives in one piece at the end of the turn.
 *
 * Settings map onto the CLI's variables: API key = ARCHYMEDES_CLOUD_TOKEN, Base URL =
 * ARCHYMEDES_CLOUD_BASE_URL, model = `auto` unless set. The spend/policy knobs have no Settings UI
 * and are read from the same environment variables the CLI reads (ARCHYMEDES_CLOUD_MAXIMUM_MICROS,
 * _CURRENCY, _REGION, _DATA_POLICY, _QUALITY_FLOOR, _TASK_KIND), with the CLI's defaults.
 */
import { randomUUID } from "node:crypto";
import type { ProviderSettings } from "../../shared/types";
import { budgetsFor } from "../core/model-capabilities";
import type { AdapterEvent, AgentAdapter, RuntimeTurn, ToolSchema } from "./adapter";

/** Every task kind the exchange's `profile.kind` accepts (CLI `routing-receipt.ts`). */
export const TASK_KINDS = [
  "coding", "design", "architecture", "security", "research", "deployment",
  "general", "code", "reasoning", "vision", "agentic", "extraction", "summarization",
  "translation", "classification", "creative",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type CloudDataPolicy = "standard" | "no-training" | "zero-retention" | "local-only";

/** Same overall cap the CLI uses for a buffered completion (its DEFAULT_TOTAL_TIMEOUT_MS). */
export const CLOUD_TOTAL_TIMEOUT_MS = 30 * 60_000;

export interface CloudOptions {
  token: string;
  baseURL: string;
  model?: string;
  maximumMicros?: number;
  currency?: string;
  region?: string;
  dataPolicy?: string;
  qualityFloor?: number;
  taskKind?: string;
  timeoutMs?: number;
}

/** An HTTP failure whose status and exchange error code stay visible. */
export class ArchymedesCloudError extends Error {
  readonly retryable?: boolean;
  constructor(readonly status: number, message: string, readonly code?: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ArchymedesCloudError";
    if (["request_previously_failed", "idempotency_conflict", "spend_limit_exceeded"].includes(code ?? "")) this.retryable = false;
    else if (code === "request_in_progress") this.retryable = true;
  }
}

/** The `archymedes.profile` sent with a hosted request. Empty fields are omitted (CLI `buildTaskProfile`). */
export function buildTaskProfile(input: { kind: TaskKind; requiredCapabilities?: readonly string[]; dataPolicy?: string; region?: string; qualityFloor?: number }): Record<string, unknown> {
  const profile: Record<string, unknown> = { kind: input.kind };
  const capabilities = (input.requiredCapabilities ?? []).filter((capability) => capability.trim().length > 0);
  if (capabilities.length > 0) profile.requiredCapabilities = capabilities;
  if (input.dataPolicy && input.dataPolicy !== "standard") profile.dataPolicy = input.dataPolicy;
  if (input.region?.trim()) profile.region = input.region.trim();
  if (typeof input.qualityFloor === "number" && input.qualityFloor > 0) profile.qualityFloor = Math.min(1, Math.max(0, input.qualityFloor));
  return profile;
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("ARCHYMEDES_CLOUD_MAXIMUM_MICROS must be a positive integer");
  return parsed;
}

function optionalUnitInterval(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error("ARCHYMEDES_CLOUD_QUALITY_FLOOR must be between zero and one");
  return parsed;
}

/** Settings plus the CLI's ARCHYMEDES_CLOUD_* variables, with the CLI's defaults (agent-matrix.ts). */
export function cloudOptionsFrom(settings: Pick<ProviderSettings, "apiKey" | "baseUrl" | "model">, environment: Record<string, string | undefined> = process.env): CloudOptions {
  return {
    token: settings.apiKey.trim(),
    baseURL: settings.baseUrl.trim(),
    model: settings.model,
    maximumMicros: optionalPositiveInteger(environment.ARCHYMEDES_CLOUD_MAXIMUM_MICROS, 5_000_000),
    currency: environment.ARCHYMEDES_CLOUD_CURRENCY?.trim().toUpperCase() || "USD",
    region: environment.ARCHYMEDES_CLOUD_REGION?.trim() || "global",
    dataPolicy: environment.ARCHYMEDES_CLOUD_DATA_POLICY?.trim() || "standard",
    qualityFloor: optionalUnitInterval(environment.ARCHYMEDES_CLOUD_QUALITY_FLOOR, 0),
    taskKind: environment.ARCHYMEDES_CLOUD_TASK_KIND?.trim() || undefined,
  };
}

/** `https://x` and `https://x/v1` both name the same exchange. */
export function cloudUrls(baseURL: string): { completion: string; plan: string; balance: string } {
  const base = baseURL.replace(/\/+$/, "");
  const v1 = base.endsWith("/v1") ? base : `${base}/v1`;
  return { completion: `${v1}/chat/completions`, plan: `${v1}/routes/plan`, balance: `${v1}/credits/balance` };
}

/** The neutral turns as Chat Completions messages (the CLI's `toWireMessages`, text-only). */
export function toWireMessages(systemPrompt: string, turns: readonly RuntimeTurn[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [{ role: "system", content: systemPrompt }];
  for (const turn of turns) {
    if (turn.kind === "text") {
      if (turn.role === "system") continue;
      wire.push({ role: turn.role, content: turn.text });
    } else if (turn.kind === "assistant-toolcalls") {
      wire.push({
        role: "assistant",
        content: turn.text || null,
        tool_calls: turn.calls.map((call) => ({ id: call.toolCallId, type: "function", function: { name: call.name, arguments: call.args || "{}" } })),
      });
    } else {
      for (const result of turn.results) wire.push({ role: "tool", content: result.result, tool_call_id: result.toolCallId, name: result.name });
    }
  }
  return wire;
}

type ChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  archymedes?: { routing_receipt?: unknown };
};

/** The model the exchange says it routed to, from its receipt (`chosen.model` or the flat spellings). */
export function routedModelOf(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== "object") return undefined;
  const value = receipt as Record<string, unknown>;
  const chosen = value.chosen && typeof value.chosen === "object" ? (value.chosen as Record<string, unknown>) : value;
  const pick = [chosen.model, value.chosen_model, value.selectedModel].find((item) => typeof item === "string" && item.trim());
  return typeof pick === "string" ? pick.trim() : undefined;
}

/**
 * One buffered completion as neutral adapter events. Mirrors the CLI's `turnFromChatResponse`: a
 * missing finish reason is inferred from the payload, a "stop" carrying tool calls is a tool turn,
 * and a turn cut off at the output cap drops its (truncated) tool calls.
 */
export function eventsFromCompletion(body: ChatResponse): AdapterEvent[] {
  const choice = body.choices?.[0];
  if (!choice?.message) throw new Error("Archymedes Cloud response contained no choices");
  const message = choice.message;
  const calls = (message.tool_calls ?? []).filter((call) => call.function?.name);
  const reason = choice.finish_reason ?? (calls.length > 0 ? "tool_calls" : message.content ? "stop" : undefined);
  if (!reason && !message.refusal) throw new Error(`Unsupported model finish reason: ${choice.finish_reason}`);
  const truncated = reason === "length" || reason === "refusal" || Boolean(message.refusal);
  const keptCalls = truncated ? [] : calls;

  const events: AdapterEvent[] = [];
  const text = message.content ?? "";
  if (text) events.push({ type: "text-delta", delta: text });
  const refusal = message.refusal ?? (reason === "refusal" ? "The provider's content filter stopped this response." : undefined);
  if (refusal && !text) events.push({ type: "text-delta", delta: refusal });
  for (const call of keptCalls) {
    events.push({
      type: "tool-call",
      invocation: { toolCallId: call.id || `call_${randomUUID()}`, name: call.function!.name!, args: call.function?.arguments || "{}" },
    });
  }
  if (!body.usage) throw new Error("Model response did not include usage accounting");
  events.push({
    type: "usage",
    inputTokens: body.usage.prompt_tokens ?? 0,
    outputTokens: body.usage.completion_tokens ?? 0,
    cachedInputTokens: body.usage.prompt_tokens_details?.cached_tokens ?? 0,
  });
  events.push({ type: "finish", stopReason: keptCalls.length > 0 ? "tool-use" : "end-turn" });
  return events;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class CloudAdapter implements AgentAdapter {
  readonly name = "archymedes-cloud";
  private readonly urls: ReturnType<typeof cloudUrls>;
  private readonly model: string;
  private readonly maximumMicros: number;
  private readonly currency: string;
  private readonly dataPolicy: CloudDataPolicy;
  private readonly qualityFloor: number;
  private readonly taskKind: TaskKind;
  /** Stable for this adapter (one run), like the CLI's per-session identifier. */
  private readonly safetyIdentifier = `archymedes_desktop_${randomUUID()}`.slice(0, 64);
  /** The model the exchange routed the last turn to, from its receipt. */
  lastRoutedModel: string | undefined;

  constructor(
    private readonly options: CloudOptions,
    private readonly dependencies: { fetchImpl?: Fetch; newTaskId?: () => string } = {},
  ) {
    if (!options.token.trim()) throw new Error("Archymedes Cloud needs a token: set it as the API key in Settings (ARCHYMEDES_CLOUD_TOKEN).");
    if (!options.baseURL.trim()) throw new Error("Archymedes Cloud needs the exchange URL: set it as the Base URL in Settings (ARCHYMEDES_CLOUD_BASE_URL).");
    const maximum = options.maximumMicros ?? 5_000_000;
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Archymedes Cloud maximum must be a positive integer number of micros");
    const currency = (options.currency ?? "USD").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Archymedes Cloud currency must be a three-letter ISO code");
    const dataPolicy = options.dataPolicy ?? "standard";
    if (!["standard", "no-training", "zero-retention", "local-only"].includes(dataPolicy)) throw new Error("Archymedes Cloud data policy is invalid");
    const qualityFloor = options.qualityFloor ?? 0;
    if (!Number.isFinite(qualityFloor) || qualityFloor < 0 || qualityFloor > 1) throw new Error("Archymedes Cloud quality floor must be between zero and one");
    const requestedKind = options.taskKind?.trim().toLowerCase();
    if (requestedKind !== undefined && !(TASK_KINDS as readonly string[]).includes(requestedKind)) {
      throw new Error(`Archymedes Cloud task kind must be one of: ${TASK_KINDS.join(", ")}`);
    }
    this.model = options.model?.trim() || "auto";
    this.maximumMicros = maximum;
    this.currency = currency;
    this.dataPolicy = dataPolicy as CloudDataPolicy;
    this.qualityFloor = qualityFloor;
    this.taskKind = (requestedKind as TaskKind | undefined) ?? "coding";
    this.urls = cloudUrls(options.baseURL);
  }

  async runTurn(input: { systemPrompt: string; turns: RuntimeTurn[]; tools: ToolSchema[]; onEvent: (event: AdapterEvent) => void; signal: AbortSignal }): Promise<void> {
    input.signal.throwIfAborted();
    const taskId = this.dependencies.newTaskId?.() ?? `desktop_${randomUUID()}`;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error("requestId must contain 1 to 160 letters, numbers, underscores or hyphens");
    const body = JSON.stringify({
      model: this.model,
      messages: toWireMessages(input.systemPrompt, input.turns),
      ...(input.tools.length > 0
        ? {
            tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
            tool_choice: "auto",
            parallel_tool_calls: true,
          }
        : {}),
      max_completion_tokens: budgetsFor(this.model).maxOutputTokens,
      safety_identifier: this.safetyIdentifier,
      prompt_cache_key: this.safetyIdentifier,
      stream: false,
      archymedes: {
        task_id: taskId,
        maximum: { currency: this.currency, micros: this.maximumMicros },
        profile: buildTaskProfile({
          kind: this.taskKind,
          requiredCapabilities: input.tools.length > 0 ? ["tools"] : [],
          dataPolicy: this.dataPolicy,
          region: this.options.region,
          qualityFloor: this.qualityFloor,
        }),
      },
    });

    // Wall-clock only: a buffered completion has no chunks to measure idleness by.
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? CLOUD_TOTAL_TIMEOUT_MS), input.signal]);
    let response: Response;
    try {
      response = await this.post(this.urls.completion, taskId, body, signal);
    } catch (error) {
      if (input.signal.aborted || signal.aborted) throw error;
      // The request may have reached the exchange before the connection broke. The idempotency key
      // lets the recovery endpoint return that outcome instead of charging for the turn twice.
      // Anything but a recovered completion reports the original failure, not the recovery's.
      const recovered = await this.post(`${this.urls.completion}/recover`, taskId, body, signal).catch(() => undefined);
      if (!recovered?.ok) throw error;
      response = recovered;
    }

    const parsed = await readBody(response);
    if (!response.ok) throw errorFrom(response, parsed);
    const completion = parsed as ChatResponse;
    this.lastRoutedModel = routedModelOf(completion.archymedes?.routing_receipt);
    for (const event of eventsFromCompletion(completion)) input.onEvent(event);
  }

  private post(url: string, taskId: string, body: string, signal: AbortSignal): Promise<Response> {
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    return fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "idempotency-key": taskId,
        "x-request-id": taskId,
      },
      body,
      signal,
    });
  }
}

function errorFrom(response: Response, body: unknown): ArchymedesCloudError {
  const problem = body as { error?: { code?: unknown; message?: unknown } };
  const code = typeof problem?.error?.code === "string" ? problem.error.code : undefined;
  const detail = typeof problem?.error?.message === "string" ? problem.error.message : `Exchange returned HTTP ${response.status}`;
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs =
    retryAfter === null ? undefined : /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
  return new ArchymedesCloudError(response.status, detail.slice(0, 500), code, retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.ok) throw new Error("Archymedes Cloud returned an invalid JSON completion");
    return {};
  }
}
