import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./tools";
import type { ToolContext } from "./tools";

let workspace: string;
let snapshots: { relPath: string; contentAtSnapshot: string | null }[];
let ctx: ToolContext;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "arch-tools-"));
  snapshots = [];
  ctx = {
    workspace,
    recordSnapshot: async (relPath) => {
      const contentAtSnapshot = await fs.readFile(path.join(workspace, relPath), "utf8").catch(() => null);
      snapshots.push({ relPath, contentAtSnapshot });
    },
  };
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("executeTool", () => {
  it("snapshots a file before overwriting it", async () => {
    await fs.writeFile(path.join(workspace, "a.txt"), "old");
    const outcome = await executeTool("write_file", JSON.stringify({ path: "a.txt", content: "new" }), ctx);
    expect(outcome).toEqual({ output: "Wrote a.txt (3 bytes).", isError: false });
    expect(snapshots).toEqual([{ relPath: "a.txt", contentAtSnapshot: "old" }]);
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new");
  });

  it("snapshots before an exact-string edit", async () => {
    await fs.writeFile(path.join(workspace, "b.ts"), "let a = 1;");
    const outcome = await executeTool("edit_file", JSON.stringify({ path: "b.ts", oldText: "1", newText: "2" }), ctx);
    expect(outcome.isError).toBe(false);
    expect(snapshots[0].contentAtSnapshot).toBe("let a = 1;");
  });

  it("flags failures explicitly instead of by output prefix", async () => {
    expect(await executeTool("read_file", JSON.stringify({ path: "missing.txt" }), ctx)).toMatchObject({ isError: true });
    expect(await executeTool("teleport", "{}", ctx)).toEqual({ output: 'Error: unknown tool "teleport"', isError: true });
    expect(await executeTool("read_file", "{not json", ctx)).toMatchObject({ isError: true });
    expect(await executeTool("read_file", "[]", ctx)).toMatchObject({ isError: true });
  });

  it("does not mistake a file that begins with 'Error' for a failed tool", async () => {
    await fs.writeFile(path.join(workspace, "log.txt"), "Error: this line is just file content");
    expect(await executeTool("read_file", JSON.stringify({ path: "log.txt" }), ctx)).toEqual({
      output: "Error: this line is just file content",
      isError: false,
    });
  });

  it("refuses paths outside the workspace", async () => {
    const outcome = await executeTool("write_file", JSON.stringify({ path: "../escape.txt", content: "x" }), ctx);
    expect(outcome.isError).toBe(true);
    expect(outcome.output).toContain("outside the project root");
  });
});
