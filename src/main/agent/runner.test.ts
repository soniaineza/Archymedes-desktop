import { describe, expect, it } from "vitest";
import { AppError } from "../../shared/app-error";
import { DEFAULT_PROVIDER_SETTINGS } from "../../shared/types";
import type { AgentEvent, ChatMessage, FreeAllowance } from "../../shared/types";
import type { AgentAdapter, RuntimeTurn } from "./adapter";
import { EARLIER_TOOL_RESULT_STUB } from "./token-saver";
import { AgentRunner, FREE_MODE_GUIDANCE, parseMentions, systemPromptFor } from "./runner";

async function runWith(adapter: AgentAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const runner = new AgentRunner(DEFAULT_PROVIDER_SETTINGS, process.cwd(), (event) => events.push(event), {
    createAdapter: () => adapter,
    recordSnapshot: async () => undefined,
  });
  await runner.run([{ id: "u1", role: "user", content: "hi" }]);
  return events;
}

describe("AgentRunner status reporting", () => {
  it("shows adapter retries as a status, and returns to waiting once text arrives", async () => {
    const events = await runWith({
      name: "retrying",
      runTurn: async ({ onEvent }) => {
        onEvent({ type: "retry", reason: "model unavailable" });
        onEvent({ type: "text-delta", delta: "ok" });
        onEvent({ type: "finish", stopReason: "end-turn" });
      },
    });
    const statuses = events.flatMap((e) => (e.type === "status" ? [e.status] : []));
    expect(statuses).toEqual(["thinking", "awaiting-model", "retrying", "awaiting-model", "idle"]);
  });

  it("keeps the code of an AppError thrown by the adapter", async () => {
    const events = await runWith({
      name: "unavailable",
      runTurn: async () => {
        throw new AppError("free-unavailable", "no gateway");
      },
    });
    expect(events).toContainEqual({ type: "error", message: "no gateway", code: "free-unavailable", params: undefined });
  });
});

describe("parseMentions", () => {
  it("finds file and directory mentions", () => {
    expect(parseMentions("fix @src/a.ts and look in @src")).toEqual(["src/a.ts", "src"]);
  });

  it("ignores email addresses", () => {
    expect(parseMentions("mail me@example.com about @README.md")).toEqual(["README.md"]);
  });

  it("strips trailing sentence punctuation", () => {
    expect(parseMentions("see @src/main.ts. Also @docs, then @notes!")).toEqual(["src/main.ts", "docs", "notes"]);
  });

  it("deduplicates repeated mentions", () => {
    expect(parseMentions("@a.ts vs @a.ts")).toEqual(["a.ts"]);
  });

  it("matches a mention at the very start", () => {
    expect(parseMentions("@package.json what deps?")).toEqual(["package.json"]);
  });
});

describe("AgentRunner token saver and meter", () => {
  const earlier: ChatMessage[] = [
    { id: "u0", role: "user", content: "read it" },
    { id: "a0", role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", args: "{}", result: "x".repeat(10_000) }] },
    { id: "a1", role: "assistant", content: "read" },
    { id: "u1", role: "user", content: "again" },
  ];

  /** Records the turns of every request, answering with one tool call and then text. */
  function recording(seen: RuntimeTurn[][]): AgentAdapter {
    return {
      name: "recording",
      runTurn: async ({ turns, onEvent }) => {
        seen.push(turns);
        if (seen.length === 1) {
          onEvent({ type: "tool-call", invocation: { toolCallId: "c1", name: "read_file", args: "{}" } });
          onEvent({ type: "finish", stopReason: "tool-use" });
        } else {
          onEvent({ type: "text-delta", delta: "done" });
          onEvent({ type: "finish", stopReason: "end-turn" });
        }
      },
    };
  }

  const bigTool = async () => ({ output: "y".repeat(20_000), isError: false });

  it("stubs earlier tool results and caps this run's tool output in free mode", async () => {
    const seen: RuntimeTurn[][] = [];
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({ ...DEFAULT_PROVIDER_SETTINGS, provider: "free" }, process.cwd(), (e) => events.push(e), {
      createAdapter: () => recording(seen),
      recordSnapshot: async () => undefined,
      executeTool: bigTool,
    });
    await runner.run(earlier);
    expect(seen[0][2]).toMatchObject({ kind: "tool-results", results: [{ toolCallId: "c0", result: EARLIER_TOOL_RESULT_STUB }] });
    const current = seen[1].at(-1);
    expect(current?.kind === "tool-results" && current.results[0].result.length).toBeLessThan(6_200);
    // The UI still gets the whole output.
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", result: "y".repeat(20_000) }));
  });

  it("sends the full history for other providers", async () => {
    const seen: RuntimeTurn[][] = [];
    const runner = new AgentRunner({ ...DEFAULT_PROVIDER_SETTINGS, provider: "openai-compatible", model: "m" }, process.cwd(), () => undefined, {
      createAdapter: () => recording(seen),
      recordSnapshot: async () => undefined,
      executeTool: bigTool,
    });
    await runner.run(earlier);
    expect(seen[0][2]).toMatchObject({ kind: "tool-results", results: [{ result: "x".repeat(10_000) }] });
    const current = seen[1].at(-1);
    expect(current?.kind === "tool-results" && current.results[0].result).toBe("y".repeat(20_000));
  });

  it("puts each turn's tokens on its message and counts them for the day, minus the pre-request allowance", async () => {
    const events: AgentEvent[] = [];
    const recorded: Array<[number, FreeAllowance | undefined]> = [];
    const runner = new AgentRunner(DEFAULT_PROVIDER_SETTINGS, process.cwd(), (e) => events.push(e), {
      createAdapter: () => ({
        name: "metered",
        runTurn: async ({ onEvent }) => {
          onEvent({ type: "allowance", remainingTokens: 10_000, resetUtc: "2026-10-09T00:00:00.000Z" });
          onEvent({ type: "text-delta", delta: "hi" });
          onEvent({ type: "usage", inputTokens: 1_200, outputTokens: 300 });
          onEvent({ type: "finish", stopReason: "end-turn" });
        },
      }),
      recordSnapshot: async () => undefined,
      recordUsage: async (tokens, allowance) => {
        recorded.push([tokens, allowance]);
        return { date: "2026-10-08", tokens, ...(allowance ? { allowance } : {}) };
      },
    });
    await runner.run([{ id: "u1", role: "user", content: "hi" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual(expect.objectContaining({ type: "message-end", usage: { inputTokens: 1_200, outputTokens: 300 } }));
    expect(recorded).toEqual([[1_500, { remainingTokens: 8_500, resetUtc: "2026-10-09T00:00:00.000Z", warning: undefined }]]);
    expect(events).toContainEqual({
      type: "daily-usage",
      usage: { date: "2026-10-08", tokens: 1_500, allowance: expect.objectContaining({ remainingTokens: 8_500 }), provider: "free" },
    });
  });
});

describe("AgentRunner in free mode: fewer requests, tolerant tool calls", () => {
  /** Answers the first request with the given tool calls, then ends; records what each request saw. */
  function twoStep(calls: { toolCallId: string; name: string; args: string }[], seen: { systemPrompt: string; turns: RuntimeTurn[] }[]): AgentAdapter {
    return {
      name: "two-step",
      runTurn: async ({ systemPrompt, turns, onEvent }) => {
        seen.push({ systemPrompt, turns: structuredClone(turns) });
        if (seen.length === 1) {
          for (const invocation of calls) onEvent({ type: "tool-call", invocation });
          onEvent({ type: "finish", stopReason: "tool-use" });
        } else {
          onEvent({ type: "text-delta", delta: "done" });
          onEvent({ type: "finish", stopReason: "end-turn" });
        }
      },
    };
  }

  async function run(provider: "free" | "anthropic", adapter: AgentAdapter) {
    const events: AgentEvent[] = [];
    const executed: { name: string; args: string }[] = [];
    const runner = new AgentRunner({ ...DEFAULT_PROVIDER_SETTINGS, provider }, process.cwd(), (event) => events.push(event), {
      createAdapter: () => adapter,
      recordSnapshot: async () => undefined,
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return { output: `ran ${name}`, isError: false };
      },
    });
    await runner.run([{ id: "u1", role: "user", content: "go" }]);
    return { events, executed };
  }

  it("asks free models to batch tool calls and not re-read files; other providers keep the plain prompt", () => {
    expect(systemPromptFor("", { frugal: true })).toContain(FREE_MODE_GUIDANCE);
    expect(FREE_MODE_GUIDANCE).toMatch(/Batch independent tool calls/);
    expect(systemPromptFor("")).not.toContain(FREE_MODE_GUIDANCE);
  });

  it("sends the free-mode guidance and runs every tool call of one turn before the next request", async () => {
    const seen: { systemPrompt: string; turns: RuntimeTurn[] }[] = [];
    const calls = [
      { toolCallId: "c1", name: "read_file", args: '{"path":"a.ts"}' },
      { toolCallId: "c2", name: "read_file", args: '{"path":"b.ts"}' },
      { toolCallId: "c3", name: "grep", args: '{"pattern":"x"}' },
    ];
    const { executed } = await run("free", twoStep(calls, seen));
    expect(seen).toHaveLength(2);
    expect(seen[0].systemPrompt).toContain(FREE_MODE_GUIDANCE);
    expect(executed.map((call) => call.args)).toEqual(['{"path":"a.ts"}', '{"path":"b.ts"}', '{"pattern":"x"}']);
    const results = seen[1].turns.find((turn) => turn.kind === "tool-results");
    expect(results?.kind === "tool-results" && results.results.map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3"]);

    const plain: { systemPrompt: string; turns: RuntimeTurn[] }[] = [];
    await run("anthropic", twoStep([], plain));
    expect(plain[0].systemPrompt).not.toContain(FREE_MODE_GUIDANCE);
  });

  it("repairs almost-JSON arguments before running the tool, and keeps valid JSON in the history", async () => {
    const seen: { systemPrompt: string; turns: RuntimeTurn[] }[] = [];
    const { executed } = await run("free", twoStep([{ toolCallId: "c1", name: "read_file", args: "```json\n{'path': 'a.ts',}\n```" }], seen));
    expect(executed).toEqual([{ name: "read_file", args: '{"path":"a.ts"}' }]);
    const assistant = seen[1].turns.find((turn) => turn.kind === "assistant-toolcalls");
    expect(assistant?.kind === "assistant-toolcalls" && assistant.calls[0].args).toBe('{"path":"a.ts"}');
  });

  it("answers unrepairable arguments with one corrective message instead of failing the run", async () => {
    const seen: { systemPrompt: string; turns: RuntimeTurn[] }[] = [];
    const { events, executed } = await run("free", twoStep([{ toolCallId: "c1", name: "write_file", args: '{"path": "a.ts", "content": "cut off' }], seen));
    expect(executed).toEqual([]);
    const result = events.find((event) => event.type === "tool-result");
    expect(result).toMatchObject({ type: "tool-result", toolCallId: "c1", isError: true });
    expect(result?.type === "tool-result" && result.result).toMatch(/not valid JSON.*Call write_file again/);
    // The run went on to the model's next turn and finished normally.
    expect(seen).toHaveLength(2);
    const assistant = seen[1].turns.find((turn) => turn.kind === "assistant-toolcalls");
    expect(assistant?.kind === "assistant-toolcalls" && assistant.calls[0].args).toBe("{}");
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});
