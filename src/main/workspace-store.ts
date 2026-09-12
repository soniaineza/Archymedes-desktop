/**
 * Workspace storage + path-scoped filesystem access.
 *
 * Every operation resolves the requested path against the workspace root and
 * refuses to escape it — the agent tools and the UI both go through this
 * module, so a prompt-injected "read C:\Users\me\.ssh\id_rsa" gets a clean
 * error instead of a leak.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { FileNode } from "../shared/types";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".cache",
  "target",
  ".venv",
  "__pycache__",
  "release",
]);

const MAX_FILE_BYTES = 512 * 1024; // 512 KiB read cap for the editor view

let workspacePath: string | null = null;

export function getWorkspacePath(): string | null {
  return workspacePath;
}

export function setWorkspacePath(p: string | null): void {
  workspacePath = p;
}

export function getSettingsDir(): string {
  return path.join(app.getPath("userData"), "settings");
}

/** Resolve a workspace-relative path, refusing escapes. Returns absolute path. */
export function resolveInWorkspace(relPath: string): string {
  if (!workspacePath) throw new Error("No workspace open");
  const abs = path.resolve(workspacePath, relPath);
  const normalizedRoot = path.resolve(workspacePath);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return abs;
}

const MAX_TREE_DEPTH = 12;

export async function listDirTree(relPath = "", depth = 0): Promise<FileNode[]> {
  const abs = resolveInWorkspace(relPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });

  const childNodes = await Promise.all(
    entries
      .filter(
        (entry) =>
          !(entry.name.startsWith(".") && entry.name !== ".env.example") &&
          !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)),
      )
      .map(async (entry): Promise<FileNode> => {
        const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        if (!entry.isDirectory()) return { name: entry.name, path: childRel, kind: "file" };
        // Depth-capped so a pathological tree can't stall the renderer.
        const children = depth < MAX_TREE_DEPTH ? await listDirTree(childRel, depth + 1) : [];
        return { name: entry.name, path: childRel, kind: "dir", children };
      }),
  );

  childNodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    // numeric: true → "v2" sorts before "v10"
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return childNodes;
}

/** A NUL byte in the first 8 KiB means binary — decoding it as UTF-8 only
 *  produces mojibake in the editor and garbage in model context. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
}

export async function readFileEntry(relPath: string) {
  const abs = resolveInWorkspace(relPath);
  const stat = await fs.stat(abs);
  if (stat.size > MAX_FILE_BYTES) {
    const handle = await fs.open(abs, "r");
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      await handle.read(buf, 0, MAX_FILE_BYTES, 0);
      if (looksBinary(buf)) throw new Error(`${relPath} is a binary file and cannot be opened in the editor.`);
      return { path: relPath, content: buf.toString("utf8"), truncated: true };
    } finally {
      await handle.close();
    }
  }
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) throw new Error(`${relPath} is a binary file and cannot be opened in the editor.`);
  return { path: relPath, content: buf.toString("utf8"), truncated: false };
}

export async function writeFileEntry(relPath: string, content: string): Promise<void> {
  const abs = resolveInWorkspace(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
