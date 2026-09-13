import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppError } from "../shared/app-error";
import type { InvokeArgs, InvokeChannel, InvokeResult } from "../shared/ipc-contract";
import { INVOKE_GUARDS, SEND_GUARDS } from "../shared/ipc-guards";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import type { AgentEvent } from "../shared/types";
import { AgentRunController } from "./agent/run-controller";
import type { AgentRun } from "./agent/run-controller";
import { registerIpc } from "./ipc";
import type { HostBridge, IpcHost } from "./ipc-host";
import { createServices } from "./services";

/** An agent run that stays in flight until cancelled. */
class PendingRun implements AgentRun {
  cancelled = false;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => (this.release = resolve));

  constructor(
    readonly workspace: string,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  async run(): Promise<void> {
    this.emit({ type: "status", status: "thinking" });
    await this.released;
  }

  cancel(): void {
    this.cancelled = true;
    this.release();
  }
}

let tmp: string;
let userData: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arch-ipc-"));
  userData = path.join(tmp, "user-data");
  projectA = path.join(tmp, "project-a");
  projectB = path.join(tmp, "project-b");
  await Promise.all([fs.mkdir(userData), fs.mkdir(projectA), fs.mkdir(projectB)]);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Registers the real IPC layer against an in-memory host, the way Electron would call it. */
function harness() {
  const invokes = new Map<string, (...args: unknown[]) => unknown>();
  const sends = new Map<string, (...args: unknown[]) => void>();
  const host: IpcHost = {
    handle: (channel, handler) => void invokes.set(channel, handler),
    on: (channel, listener) => void sends.set(channel, listener),
  };

  const emitted: { channel: string; payload: unknown[] }[] = [];
  let nextPick: string | null = null;
  const bridge: HostBridge = {
    pickDirectory: async () => nextPick,
    emit: (channel, ...payload) => void emitted.push({ channel, payload }),
  };

  const runs: PendingRun[] = [];
  const watcher = { start: vi.fn(), stop: vi.fn() };
  const terminals = {
    create: vi.fn(() => {
      throw new Error("no shells in tests");
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onExit: vi.fn(),
    disposeAll: vi.fn(),
  };
  const agent = new AgentRunController((_settings, workspace, emit) => {
    const run = new PendingRun(workspace, emit);
    runs.push(run);
    return run;
  });
  const services = createServices({ userData }, { agent, watcher, terminals });
  registerIpc(host, services, bridge);

  return {
    invokes,
    sends,
    emitted,
    runs,
    watcher,
    terminals,
    services,
    pick: (dir: string | null) => (nextPick = dir),
    invoke: <K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>) =>
      Promise.resolve(invokes.get(channel)!(...args)) as Promise<InvokeResult<K>>,
    invokeRaw: (channel: string, ...args: unknown[]) => Promise.resolve(invokes.get(channel)!(...args)),
    send: (channel: string, ...args: unknown[]) => sends.get(channel)!(...args),
  };
}

async function errorCode(promise: Promise<unknown>) {
  return parseAppError(await promise.then(() => new Error("expected a rejection"), (e: unknown) => e)).code;
}

describe("IPC registration", () => {
  it("registers a handler for every channel in the contract", () => {
    const { invokes, sends } = harness();
    expect([...invokes.keys()].sort()).toEqual(Object.keys(INVOKE_GUARDS).sort());
    expect([...sends.keys()].sort()).toEqual(Object.keys(SEND_GUARDS).sort());
  });
});

describe("workspace and files", () => {
  it("refuses file access until a workspace is open, with a translatable code", async () => {
    const ipc = harness();
    expect(await errorCode(ipc.invoke("fs:read-file", "a.txt"))).toBe("no-workspace");
  });

  it("writes, reads and lists files in the open workspace", async () => {
    const ipc = harness();
    await ipc.invoke("fs:set-workspace", projectA);
    await ipc.invoke("fs:write-file", "src/hello.ts", "export {};\n");
    expect(await ipc.invoke("fs:read-file", "src/hello.ts")).toEqual({ path: "src/hello.ts", content: "export {};\n", truncated: false });
    const tree = await ipc.invoke("fs:list-tree", "");
    expect(tree[0]).toMatchObject({ name: "src", kind: "dir" });
  });

  it("rejects malformed renderer arguments before they reach a handler", async () => {
    const ipc = harness();
    await ipc.invoke("fs:set-workspace", projectA);
    expect(await errorCode(ipc.invokeRaw("fs:read-file", 42))).toBe("invalid-argument");
    expect(await errorCode(ipc.invokeRaw("settings:save", { provider: "evil" }))).toBe("invalid-argument");
  });

  it("refuses to escape the workspace", async () => {
    const ipc = harness();
    await ipc.invoke("fs:set-workspace", projectA);
    await expect(ipc.invoke("fs:read-file", "../project-b/secret.txt")).rejects.toThrow();
  });

  it("opens the directory the user picks, and does nothing when they cancel", async () => {
    const ipc = harness();
    ipc.pick(null);
    expect(await ipc.invoke("fs:pick-workspace")).toBeNull();
    ipc.pick(projectB);
    expect(await ipc.invoke("fs:pick-workspace", "Choose")).toBe(projectB);
    expect(await ipc.invoke("fs:get-workspace")).toBe(projectB);
  });
});

describe("settings", () => {
  it("round-trips through the userData directory", async () => {
    const ipc = harness();
    const settings = { ...DEFAULT_PROVIDER_SETTINGS, provider: "groq" as const, apiKey: "key" };
    await ipc.invoke("settings:save", settings);
    expect(await ipc.invoke("settings:get")).toEqual(settings);
  });
});

describe("agent runs", () => {
  it("refuses to start without an API key, with a translatable code", async () => {
    const ipc = harness();
    await ipc.invoke("fs:set-workspace", projectA);
    expect(await errorCode(ipc.invoke("agent:send", []))).toBe("no-api-key");
    expect(ipc.runs).toHaveLength(0);
  });

  it("streams events to the renderer and cancels the run when the workspace changes", async () => {
    const ipc = harness();
    await ipc.invoke("settings:save", { ...DEFAULT_PROVIDER_SETTINGS, provider: "ollama", apiKey: "" });
    await ipc.invoke("fs:set-workspace", projectA);

    const sending = ipc.invoke("agent:send", []);
    await vi.waitFor(() => expect(ipc.runs).toHaveLength(1));
    expect(ipc.runs[0].workspace).toBe(projectA);
    expect(ipc.emitted).toContainEqual({ channel: "agent:event", payload: [{ type: "status", status: "thinking" }] });

    await ipc.invoke("fs:set-workspace", projectB);
    expect(ipc.runs[0].cancelled).toBe(true);
    expect(ipc.watcher.stop).toHaveBeenCalled();
    await sending;
  });

  it("does not cancel the run when the same workspace is set again", async () => {
    const ipc = harness();
    await ipc.invoke("settings:save", { ...DEFAULT_PROVIDER_SETTINGS, provider: "ollama", apiKey: "" });
    await ipc.invoke("fs:set-workspace", projectA);
    const sending = ipc.invoke("agent:send", []);
    await vi.waitFor(() => expect(ipc.runs).toHaveLength(1));

    await ipc.invoke("fs:set-workspace", projectA);
    expect(ipc.runs[0].cancelled).toBe(false);

    await ipc.invoke("agent:cancel");
    await sending;
  });
});

describe("diffs", () => {
  it("reverts an agent edit and tells the renderer to refresh", async () => {
    const ipc = harness();
    await ipc.invoke("fs:set-workspace", projectA);
    await fs.writeFile(path.join(projectA, "notes.md"), "before\n");
    await ipc.services.snapshots.recordBefore(projectA, "notes.md");
    await fs.writeFile(path.join(projectA, "notes.md"), "after\n");

    expect((await ipc.invoke("diff:list-edits")).map((e) => e.path)).toEqual(["notes.md"]);
    await ipc.invoke("diff:revert", "notes.md");

    expect(await fs.readFile(path.join(projectA, "notes.md"), "utf8")).toBe("before\n");
    expect(ipc.emitted).toContainEqual({ channel: "watch:event", payload: [{ changed: true }] });
  });
});

describe("terminals", () => {
  it("forwards well-formed input and drops malformed resizes", () => {
    const ipc = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ipc.send("term:write", "term-1", "ls\r");
    ipc.send("term:resize", "term-1", -5, 24);
    expect(ipc.terminals.write).toHaveBeenCalledWith("term-1", "ls\r");
    expect(ipc.terminals.resize).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("shutdown", () => {
  it("cancels the agent, stops watching and kills every shell", async () => {
    const ipc = harness();
    await ipc.invoke("settings:save", { ...DEFAULT_PROVIDER_SETTINGS, provider: "ollama", apiKey: "" });
    await ipc.invoke("fs:set-workspace", projectA);
    const sending = ipc.invoke("agent:send", []);
    await vi.waitFor(() => expect(ipc.runs).toHaveLength(1));

    ipc.services.dispose();

    expect(ipc.runs[0].cancelled).toBe(true);
    expect(ipc.watcher.stop).toHaveBeenCalled();
    expect(ipc.terminals.disposeAll).toHaveBeenCalledOnce();
    await sending;
  });
});
