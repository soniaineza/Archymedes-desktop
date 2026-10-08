import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "../../shared/types";
import type { AdapterEvent, RuntimeTurn, ToolSchema } from "./adapter";
import { createAdapter } from "./adapters";
import { ArchymedesCloudError, buildTaskProfile, CloudAdapter, cloudOptionsFrom, cloudUrls, eventsFromCompletion, routedModelOf } from "./cloud-adapter";

const TOKEN = "cloud-token-xyz";
const TOOLS: ToolSchema[] = [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }];
const TURNS: RuntimeTurn[] = [
  { kind: "text", role: "user", text: "fix it" },
  { kind: "assistant-toolcalls", text: "", calls: [{ toolCallId: "c1", name: "read_file", args: '{"path":"a"}' }] },
  { kind: "tool-results", results: [{ toolCallId: "c1", name: "read_file", args: '{"path":"a"}', result: "A", isError: false }] },
];

const completion = {
  id: "chatcmpl-1",
  model: "routed-model",
  choices: [{ finish_reason: "tool_calls", message: { content: "Reading.", tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } }] } }],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 100 } },
  archymedes: { routing_receipt: { chosen: { model: "claude-sonnet-5", provider: "anthropic" } } },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

async function run(adapter: CloudAdapter, signal = new AbortController().signal): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn({ systemPrompt: "You are helpful.", turns: TURNS, tools: TOOLS, onEvent: (e) => events.push(e), signal });
  return events;
}

describe("CloudAdapter", () => {
  it("sends one buffered, spend-capped, idempotent completion and emits its events", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => json(completion));
    const adapter = new CloudAdapter({ token: TOKEN, baseURL: "https://exchange.example/" }, { fetchImpl, newTaskId: () => "task_1" });
    const events = await run(adapter);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://exchange.example/v1/chat/completions");
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": "task_1", "x-request-id": "task_1" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "auto",
      stream: false,
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_completion_tokens: 16_000,
      archymedes: { task_id: "task_1", maximum: { currency: "USD", micros: 5_000_000 }, profile: { kind: "coding", requiredCapabilities: ["tools"] } },
    });
    expect(body.safety_identifier).toMatch(/^archymedes_desktop_/);
    expect(body.prompt_cache_key).toBe(body.safety_identifier);
    expect(body.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "fix it" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", content: "A", tool_call_id: "c1", name: "read_file" },
    ]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }]);

    expect(events).toEqual([
      { type: "text-delta", delta: "Reading." },
      { type: "tool-call", invocation: { toolCallId: "c2", name: "read_file", args: '{"path":"b"}' } },
      { type: "usage", inputTokens: 120, outputTokens: 30, cachedInputTokens: 100 },
      { type: "finish", stopReason: "tool-use" },
    ]);
    expect(adapter.lastRoutedModel).toBe("claude-sonnet-5");
  });

  it("raises the exchange's error with status, code and retry-after", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "spend_limit_exceeded", message: "Over the cap" } }, 402, { "retry-after": "2" }));
    const error = await run(new CloudAdapter({ token: TOKEN, baseURL: "https://exchange.example/v1" }, { fetchImpl })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchymedesCloudError);
    expect(error).toMatchObject({ status: 402, code: "spend_limit_exceeded", message: "Over the cap", retryAfterMs: 2000, retryable: false });
  });

  it("asks the recovery endpoint with the same task id when the connection breaks", async () => {
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(json(completion));
    const events = await run(new CloudAdapter({ token: TOKEN, baseURL: "https://exchange.example" }, { fetchImpl, newTaskId: () => "task_9" }));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://exchange.example/v1/chat/completions", "https://exchange.example/v1/chat/completions/recover"]);
    expect((fetchImpl.mock.calls[1][1].headers as Record<string, string>)["idempotency-key"]).toBe("task_9");
    expect(events.at(-1)).toEqual({ type: "finish", stopReason: "tool-use" });
  });

  it("reports the original failure when recovery has nothing", async () => {
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(json({ error: { message: "unknown task" } }, 404));
    await expect(run(new CloudAdapter({ token: TOKEN, baseURL: "https://exchange.example" }, { fetchImpl }))).rejects.toThrow("socket hang up");
  });

  it("does not recover a request the user cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(run(new CloudAdapter({ token: TOKEN, baseURL: "https://exchange.example" }, { fetchImpl }), controller.signal)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("validates token, URL and policy knobs like the CLI", () => {
    expect(() => new CloudAdapter({ token: " ", baseURL: "https://x" })).toThrow(/token/);
    expect(() => new CloudAdapter({ token: TOKEN, baseURL: "" })).toThrow(/Base URL/);
    expect(() => new CloudAdapter({ token: TOKEN, baseURL: "https://x", currency: "dollars" })).toThrow(/currency/);
    expect(() => new CloudAdapter({ token: TOKEN, baseURL: "https://x", dataPolicy: "whatever" })).toThrow(/data policy/);
    expect(() => new CloudAdapter({ token: TOKEN, baseURL: "https://x", taskKind: "juggling" })).toThrow(/task kind/);
    expect(() => cloudOptionsFrom({ apiKey: TOKEN, baseUrl: "https://x", model: "auto" }, { ARCHYMEDES_CLOUD_MAXIMUM_MICROS: "-1" })).toThrow(/MAXIMUM_MICROS/);
  });

  it("maps settings and ARCHYMEDES_CLOUD_* variables with the CLI's defaults", () => {
    expect(cloudOptionsFrom({ apiKey: ` ${TOKEN} `, baseUrl: "https://x", model: "auto" }, {})).toEqual({
      token: TOKEN, baseURL: "https://x", model: "auto", maximumMicros: 5_000_000, currency: "USD", region: "global", dataPolicy: "standard", qualityFloor: 0, taskKind: undefined,
    });
    expect(cloudOptionsFrom({ apiKey: TOKEN, baseUrl: "https://x", model: "auto" }, { ARCHYMEDES_CLOUD_CURRENCY: "rwf", ARCHYMEDES_CLOUD_QUALITY_FLOOR: "0.5" })).toMatchObject({ currency: "RWF", qualityFloor: 0.5 });
  });

  it("is what createAdapter builds for archymedes-cloud", () => {
    const adapter = createAdapter({ ...DEFAULT_PROVIDER_SETTINGS, provider: "archymedes-cloud", model: "auto", apiKey: TOKEN, baseUrl: "https://exchange.example" });
    expect(adapter.name).toBe("archymedes-cloud");
  });
});

describe("cloud protocol helpers", () => {
  it("builds exchange URLs with or without /v1", () => {
    expect(cloudUrls("https://x/v1/")).toEqual({ completion: "https://x/v1/chat/completions", plan: "https://x/v1/routes/plan", balance: "https://x/v1/credits/balance" });
    expect(cloudUrls("https://x").completion).toBe("https://x/v1/chat/completions");
  });

  it("omits empty profile fields", () => {
    expect(buildTaskProfile({ kind: "coding", dataPolicy: "standard", region: " ", qualityFloor: 0 })).toEqual({ kind: "coding" });
    expect(buildTaskProfile({ kind: "coding", requiredCapabilities: ["tools", " "], dataPolicy: "zero-retention", region: "eu", qualityFloor: 2 })).toEqual({
      kind: "coding", requiredCapabilities: ["tools"], dataPolicy: "zero-retention", region: "eu", qualityFloor: 1,
    });
  });

  it("drops truncated tool calls and infers a missing finish reason", () => {
    const base = { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const call = { id: "c", function: { name: "f", arguments: '{"a' } };
    expect(eventsFromCompletion({ ...base, choices: [{ finish_reason: "length", message: { content: "", tool_calls: [call] } }] }).filter((e) => e.type === "tool-call")).toEqual([]);
    expect(eventsFromCompletion({ ...base, choices: [{ finish_reason: null, message: { content: null, tool_calls: [call] } }] }).at(-1)).toEqual({ type: "finish", stopReason: "tool-use" });
    expect(eventsFromCompletion({ ...base, choices: [{ finish_reason: "stop", message: { content: "done" } }] }).at(-1)).toEqual({ type: "finish", stopReason: "end-turn" });
    expect(() => eventsFromCompletion({ choices: [{ finish_reason: "stop", message: { content: "x" } }] })).toThrow(/usage/);
  });

  it("reads the routed model from any receipt spelling", () => {
    expect(routedModelOf({ chosen: { model: "m1" } })).toBe("m1");
    expect(routedModelOf({ chosen_model: "m2" })).toBe("m2");
    expect(routedModelOf("nope")).toBeUndefined();
  });
});
