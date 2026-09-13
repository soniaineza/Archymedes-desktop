import fs from "node:fs/promises";
import path from "node:path";
import type { SearchHit, SearchResult } from "../shared/types";
import { DEFAULT_WORKSPACE_LIMITS } from "./core/workspace";

/**
 * A grep-lite over the workspace: case-insensitive literal search, skips
 * heavy/binary directories, and returns line-level hits capped so the UI
 * stays responsive. Symlinks are never followed (only real files are walked).
 */

const SKIP_DIRS = new Set(DEFAULT_WORKSPACE_LIMITS.ignoredDirectories);
const MAX_HITS = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf",
  ".eot", ".zip", ".gz", ".exe", ".dll", ".so", ".dylib", ".lock", ".bin",
  ".pdf", ".mp4", ".mp3", ".wasm", ".node", ".map",
]);

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(path.join(dir, entry.name), childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
}

export async function workspaceSearch(root: string, rawQuery: string): Promise<SearchResult> {
  const query = rawQuery.trim();
  if (query.length < 2) return { truncated: false, hits: [] };
  const files: string[] = [];
  await walk(root, "", files);

  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const rel of files) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(root, rel);
    let content: string;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue; // binary heuristic

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      if (hits.length >= MAX_HITS) return { truncated: true, hits };
      hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }

  return { truncated: false, hits };
}
