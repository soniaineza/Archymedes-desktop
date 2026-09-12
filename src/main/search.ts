import fs from "node:fs/promises";
import path from "node:path";
import type { SearchHit, SearchResult } from "../shared/types";
import { resolveInWorkspace } from "./workspace-store";

/**
 * A grep-lite over the workspace: case-insensitive literal search, skips
 * heavy/binary directories, and returns line-level hits capped so the UI
 * stays responsive.
 */

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".cache",
  "target", ".venv", "__pycache__", "release", "coverage",
]);

const MAX_HITS = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf",
  ".eot", ".zip", ".gz", ".exe", ".dll", ".so", ".dylib", ".lock", ".bin",
  ".pdf", ".mp4", ".mp3", ".wasm", ".node", ".map",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".scss", ".html",
  ".rs", ".py", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb",
  ".php", ".sh", ".bash", ".ps1", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".txt", ".svg", ".xml", ".sql", ".env", ".gitignore", ".npmrc",
]);

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_HITS) return;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(path.join(dir, entry.name), childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
}

export async function workspaceSearch(rawQuery: string, caseSensitive = false): Promise<SearchResult> {
  const query = rawQuery.trim();
  if (query.length < 2) return { truncated: false, hits: [], caseSensitive };
  const root = resolveInWorkspace("");
  const files: string[] = [];
  await walk(root, "", files);

  const needle = caseSensitive ? query : query.toLowerCase();
  const hits: SearchHit[] = [];
  let truncated = false;

  for (const rel of files) {
    if (hits.length >= MAX_HITS) {
      truncated = true;
      break;
    }
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    if (!TEXT_EXT.has(ext) && !rel.startsWith(".")) {
      // unknown extension: allow small files anyway
    }
    let abs: string;
    try {
      abs = resolveInWorkspace(rel);
    } catch {
      continue;
    }
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
      const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (haystack.includes(needle)) {
        hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
        if (hits.length >= MAX_HITS) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { truncated, hits, caseSensitive };
}
