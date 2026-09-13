import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "../../shared/types";
import type { AgentEvent, ChatMessage, ProviderSettings } from "../../shared/types";
import { priceUsage } from "../core/money";
import { catalogPricesOf } from "../core/price-lookup";
import { SnapshotStore } from "../snapshots";
import { AgentRunner } from "./runner";
import { createScriptedAdapter } from "./scripted-adapter";
import type { ScriptedTurn } from "./scripted-adapter";

let tmp: string;
let workspace: string;
let userData: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arch-loop-"));
  workspace = path.join(tmp, "project");
  userData = path.join(tmp, "user-data");
  await Promise.all([fs.mkdir(workspace), fs.mkdir(userData)]);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const ask = (content: string): ChatMessage[] => [{ id: "u1", role: "user", content }];

/** The real runner and real tools, with only the model scripted. */
function start(script: ScriptedTurn[], settings: Partial<ProviderSettings> = {}) {
  const events: AgentEvent[] = [];
  const adapter = createScriptedAdapter(script);
  const snapshots = new SnapshotStore(userData);
  const runSettings = { ...DEFAULT_PROVIDER_SETTINGS, maxIterations: 10, ...settings };
  const runner = new AgentRunner(runSettings, workspace, (event) => events.push(event), {
    createAdapter: () => adapter,
    recordSnapshot: (root, relPath) => snapshots.recordBefore(root, relPath),
  });
  return { runner, events, adapter, snapshots, settings: runSettings };
}

function types(events: AgentEvent[]): string[] {
  return events.map((e) => (e.type === "status" ? `status:${e.status}` : e.type));
}

/** True when `expected` appears in `actual` in order, not necessarily adjacent. */
function inOrder(actual: string[], expected: string[]): boolean {
  let i = 0;
  for (const item of actual) if (item === expected[i]) i += 1;
  return i === expected.length;
}

const writeCall = (relPath: string, content: string) => ({
  toolCallId: `call-${relPath}`,
  name: "write_file",
  args: JSON.stringify({ path: relPath, content }),
});

describe("agent tool loop, end to end", () => {
  it("runs a tool, feeds the result back, and finishes the turn", async () => {
    const usage = { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 400 };
    const { runner, events, adapter, snapshots, settings } = start([
      { calls: [writeCall("hello.txt", "hi\n")], usage },
      { text: "Created hello.txt." },
    ]);

    await runner.run(ask("create hello.txt"));

    expect(
      inOrder(types(events), [
        "status:thinking",
        "message-start",
        "tool-start",
        "cost",
        "message-end",
        "tool-result",
        "message-start",
        "text-delta",
        "message-end",
        "status:idle",
        "done",
      ]),
    ).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);

    // The tool really ran against the workspace.
    expect(await fs.readFile(path.join(workspace, "hello.txt"), "utf8")).toBe("hi\n");

    // The second request carried the tool result back to the model.
    const secondRequest = adapter.requests[1];
    expect(secondRequest.at(-1)).toMatchObject({
      kind: "tool-results",
      results: [{ toolCallId: "call-hello.txt", isError: false }],
    });

    // A snapshot was taken first, so the edit can be diffed and reverted.
    const diff = await snapshots.diff(workspace, "hello.txt");
    expect(diff?.isNew).toBe(true);

    // Cost follows the dated price catalog, or reports unpriced honestly.
    const cost = events.find((e) => e.type === "cost");
    const prices = catalogPricesOf(settings.provider, settings.model);
    expect(cost).toMatchObject({ cost: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 400, unpriced: !prices } });
    if (prices && cost?.type === "cost") expect(cost.cost.costMicros).toBe(priceUsage(usage, prices).micros);
  });

  it("reports a failed tool to the model as an error and keeps going", async () => {
    await fs.writeFile(path.join(workspace, "a.ts"), "const x = 1;\n");
    const { runner, events, adapter } = start([
      { calls: [{ toolCallId: "e1", name: "edit_file", args: JSON.stringify({ path: "a.ts", oldText: "missing", newText: "y" }) }] },
      { text: "That text isn't there." },
    ]);

    await runner.run(ask("edit a.ts"));

    const result = events.find((e) => e.type === "tool-result");
    expect(result).toMatchObject({ type: "tool-result", isError: true });
    expect(adapter.requests[1].at(-1)).toMatchObject({ kind: "tool-results", results: [{ isError: true }] });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(await fs.readFile(path.join(workspace, "a.ts"), "utf8")).toBe("const x = 1;\n");
  });

  it("refuses to let the model write outside the workspace", async () => {
    const { runner, events } = start([{ calls: [writeCall("../escape.txt", "pwned")] }, { text: "ok" }]);
    await runner.run(ask("go"));
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ isError: true });
    await expect(fs.stat(path.join(tmp, "escape.txt"))).rejects.toThrow();
  });

  it("ends quietly, not with an error, when cancelled mid-response", async () => {
    const neverFinishes = new Promise<void>(() => {});
    const { runner, events } = start([{ text: "Let me think", holdUntil: neverFinishes }]);

    const running = runner.run(ask("go"));
    while (!events.some((e) => e.type === "text-delta")) await new Promise((r) => setTimeout(r, 1));
    runner.cancel();
    await running;

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(types(events).slice(-2)).toEqual(["status:idle", "done"]);
  });

  it("stops at the iteration limit with a translatable code", async () => {
    const listCall = { toolCallId: "l", name: "list_dir", args: "{}" };
    const { runner, events } = start([{ calls: [listCall] }, { calls: [listCall] }], { maxIterations: 2 });

    await runner.run(ask("loop forever"));

    expect(events).toContainEqual({
      type: "error",
      message: "Reached the iteration limit (2).",
      code: "iteration-limit",
      params: { count: 2 },
    });
  });

  it("surfaces a provider error", async () => {
    const { runner, events } = start([{ stop: "error", errorMessage: "rate limited" }]);
    await runner.run(ask("go"));
    expect(events).toContainEqual({ type: "error", message: "rate limited" });
    expect(types(events).at(-1)).toBe("status:error");
  });

  it("closes the assistant message when the provider call throws mid-stream", async () => {
    const events: AgentEvent[] = [];
    const snapshots = new SnapshotStore(userData);
    const runner = new AgentRunner({ ...DEFAULT_PROVIDER_SETTINGS, maxIterations: 10 }, workspace, (e) => events.push(e), {
      createAdapter: () => ({
        name: "throwing",
        async runTurn({ onEvent }) {
          onEvent({ type: "text-delta", delta: "partial" });
          throw new Error("connection reset");
        },
      }),
      recordSnapshot: (root, relPath) => snapshots.recordBefore(root, relPath),
    });

    await runner.run(ask("go"));

    expect(events).toContainEqual({ type: "error", message: "connection reset" });
    // The partial assistant message was closed, not left pending forever.
    expect(events.filter((e) => e.type === "message-start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message-end")).toHaveLength(1);
    expect(inOrder(types(events), ["message-start", "message-end", "error", "status:error"])).toBe(true);
  });

  it("attaches @mentioned files to what the model sees", async () => {
    await fs.writeFile(path.join(workspace, "notes.md"), "remember the milk");
    const { runner, adapter } = start([{ text: "Noted." }]);

    await runner.run(ask("summarize @notes.md please"));

    expect(adapter.requests[0].at(-1)).toMatchObject({ kind: "text", role: "user" });
    expect(JSON.stringify(adapter.requests[0].at(-1))).toContain("remember the milk");
  });
});
