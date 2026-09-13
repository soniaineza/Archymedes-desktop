import type { ToolSchema } from "./adapter";
import {
  WorkspaceViolation,
  editTextFile,
  globWorkspace,
  grepWorkspace,
  listFilesFallback,
  readTextFile,
  writeTextFile,
} from "../core/workspace-bridge";
import { runGuardedCommand } from "../core/command";

/**
 * The agent's hands, backed by the CLI core's workspace boundary: every path is
 * symlink-checked, reads are line-windowed, edits are exact-string, and
 * commands run through the bounded executor with policy guards.
 */

export interface ToolContext {
  workspace: string;
  /** Called before a file is modified, so the edit can be diffed and reverted. */
  recordSnapshot(relPath: string): Promise<void>;
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
}

export type ToolExecutor = (name: string, argsJson: string, ctx: ToolContext) => Promise<ToolOutcome>;

const MAX_TOOL_OUTPUT = 16_000;

function cap(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return text.slice(0, MAX_TOOL_OUTPUT) + `\n… [output truncated at ${MAX_TOOL_OUTPUT} chars]`;
}

const ok = (output: string): ToolOutcome => ({ output: cap(output), isError: false });
const fail = (message: string): ToolOutcome => ({ output: cap(`Error: ${message}`), isError: true });

export const AGENT_TOOLS: ToolSchema[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the project. Supports an optional 1-based line window (offset/limit) for very large files. Paths are workspace-relative.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        offset: { type: "integer", description: "1-based first line to return" },
        limit: { type: "integer", description: "How many lines to return" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a file or replace its entire contents. For changing part of an existing file, use edit_file instead.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string", description: "Full new file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file. oldText must appear exactly once unless replaceAll is true; include surrounding lines to make it unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "list_dir",
    description: "List files and directories under a path in the project (recursive; heavy dirs like node_modules are skipped).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative directory; empty = root" } },
      required: [],
    },
  },
  {
    name: "glob_files",
    description: "Find files whose path matches a glob, e.g. 'src/**/*.ts' or '**/*.{js,ts}'.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "grep_files",
    description: "Search file contents. Fixed-string by default; set regex true for a pattern. Filter files with the include glob.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        include: { type: "string", description: "Glob limiting which files are searched" },
        regex: { type: "boolean" },
      },
      required: ["query"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a bounded shell command in the project root (builds, tests, linters, git inspection). Output is capped; the process tree is killed on timeout. `rm -rf` is refused by policy.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

export const executeTool: ToolExecutor = async (name, argsJson, { workspace, recordSnapshot }) => {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argsJson || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("tool arguments must be a JSON object");
    args = parsed as Record<string, unknown>;
  } catch {
    return fail(`tool arguments are not valid JSON: ${argsJson}`);
  }

  try {
    switch (name) {
      case "read_file": {
        const result = await readTextFile(workspace, String(args.path ?? ""), {
          offset: typeof args.offset === "number" ? args.offset : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        const header = result.truncated
          ? `${result.path} (lines ${result.startLine}-${result.startLine + result.content.split("\n").length - 1} of ${result.totalLines})\n`
          : "";
        return ok(header + result.content);
      }
      case "write_file": {
        await recordSnapshot(String(args.path ?? ""));
        const result = await writeTextFile(workspace, String(args.path ?? ""), String(args.content ?? ""));
        return ok(`Wrote ${result.path} (${result.bytesWritten} bytes).`);
      }
      case "edit_file": {
        await recordSnapshot(String(args.path ?? ""));
        const result = await editTextFile(workspace, String(args.path ?? ""), String(args.oldText ?? ""), String(args.newText ?? ""), {
          replaceAll: args.replaceAll === true,
        });
        return ok(`Edited ${result.path} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}).`);
      }
      case "list_dir":
        return ok(await listFilesFallback(workspace, String(args.path ?? "")));
      case "glob_files": {
        const matches = await globWorkspace(workspace, String(args.pattern ?? ""));
        return ok(matches.length > 0 ? matches.join("\n") : "No files matched.");
      }
      case "grep_files": {
        const matches = await grepWorkspace(workspace, String(args.query ?? ""), {
          include: typeof args.include === "string" ? args.include : undefined,
          regex: args.regex === true,
        });
        return ok(matches.length > 0 ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") : "No matches.");
      }
      case "run_command": {
        const { exitCode, stdout, stderr } = await runGuardedCommand(String(args.command ?? ""), {
          cwd: workspace,
          timeoutMs: 120_000,
        });
        const parts = [`exit code: ${exitCode}`];
        if (stdout.trim()) parts.push(`stdout:\n${stdout}`);
        if (stderr.trim()) parts.push(`stderr:\n${stderr}`);
        // A failing command is a normal result the model should read, not a tool error.
        return ok(parts.join("\n"));
      }
      default:
        return fail(`unknown tool "${name}"`);
    }
  } catch (err) {
    if (err instanceof WorkspaceViolation) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
};
