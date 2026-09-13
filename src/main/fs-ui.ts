import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileEntry, FileNode } from "../shared/types";
import { DEFAULT_WORKSPACE_LIMITS, realPathWithin } from "./core/workspace";

/**
 * File operations for the editor and file tree. Unlike the agent's tools, the
 * editor truncates large files instead of refusing them. Every path goes
 * through the same workspace boundary as the tools.
 */

const EDITOR_READ_LIMIT = 512 * 1024;
const IGNORED = new Set(DEFAULT_WORKSPACE_LIMITS.ignoredDirectories);

export async function listDirTree(root: string, relPath = ""): Promise<FileNode[]> {
  const abs = await realPathWithin(root, relPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: childRel, kind: "dir", children: await listDirTree(root, childRel) });
    } else {
      nodes.push({ name: entry.name, path: childRel, kind: "file" });
    }
  }

  return nodes.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
}

export async function readFileForEditor(root: string, relPath: string): Promise<FileEntry> {
  const abs = await realPathWithin(root, relPath);
  const stat = await fs.stat(abs);
  if (stat.size <= EDITOR_READ_LIMIT) {
    return { path: relPath, content: await fs.readFile(abs, "utf8"), truncated: false };
  }
  const handle = await fs.open(abs, "r");
  try {
    const buffer = Buffer.alloc(EDITOR_READ_LIMIT);
    await handle.read(buffer, 0, EDITOR_READ_LIMIT, 0);
    return { path: relPath, content: buffer.toString("utf8"), truncated: true };
  } finally {
    await handle.close();
  }
}

export async function writeFileFromEditor(root: string, relPath: string, content: string): Promise<void> {
  const abs = await realPathWithin(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
