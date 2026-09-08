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

export async function listDirTree(relPath = ""): Promise<FileNode[]> {
  const abs = resolveInWorkspace(relPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRel,
        kind: "dir",
        children: await listDirTree(childRel),
      });
    } else {
      nodes.push({ name: entry.name, path: childRel, kind: "file" });
    }
  }

  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export async function readFileEntry(relPath: string) {
  const abs = resolveInWorkspace(relPath);
  const stat = await fs.stat(abs);
  if (stat.size > MAX_FILE_BYTES) {
    const handle = await fs.open(abs, "r");
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      await handle.read(buf, 0, MAX_FILE_BYTES, 0);
      return { path: relPath, content: buf.toString("utf8"), truncated: true };
    } finally {
      await handle.close();
    }
  }
  const content = await fs.readFile(abs, "utf8");
  return { path: relPath, content, truncated: false };
}

export async function writeFileEntry(relPath: string, content: string): Promise<void> {
  const abs = resolveInWorkspace(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
