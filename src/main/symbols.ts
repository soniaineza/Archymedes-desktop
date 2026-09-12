import path from "node:path";
import { promises as fs } from "node:fs";
import { walkWorkspace } from "./core/workspace";
import type { SymbolHit, SymbolKind } from "../shared/types";

/**
 * Workspace-wide symbol search: functions, classes, interfaces, types, enums,
 * structs, traits. Regex-based per language — no language server, but good
 * enough for "where was that helper defined?" across a repo. Results are
 * cached per file until its mtime changes, so keystroke repeats are cheap.
 */

const MAX_RESULTS = 500;
const MAX_FILE_BYTES = 512_000;

/** Extension → symbol extraction patterns. */
const PATTERNS: ReadonlyArray<{ exts: ReadonlySet<string>; rules: ReadonlyArray<{ re: RegExp; kind: SymbolKind }> }> = [
  {
    exts: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
    rules: [
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
      { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
      { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
      { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
      { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
      { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: "function" },
    ],
  },
  {
    exts: new Set([".py"]),
    rules: [
      { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    ],
  },
  {
    exts: new Set([".rs"]),
    rules: [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
      { re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w:<>, ]*)/, kind: "impl" },
    ],
  },
  {
    exts: new Set([".go"]),
    rules: [
      { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
      { re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: "struct" },
    ],
  },
];

function patternsFor(ext: string) {
  return PATTERNS.find((p) => p.exts.has(ext));
}

// ----- per-file cache -----

interface CacheEntry {
  mtimeMs: number;
  symbols: SymbolHit[];
}
const cache = new Map<string, CacheEntry>();
let cacheWorkspace: string | null = null;

function clearCacheIfWorkspaceChanged(workspace: string): void {
  if (cacheWorkspace !== workspace) {
    cache.clear();
    cacheWorkspace = workspace;
  }
}

async function extractFromFile(absolute: string, rel: string, ext: string): Promise<SymbolHit[]> {
  const patterns = patternsFor(ext);
  if (!patterns) return [];

  const stat = await fs.stat(absolute);
  const cached = cache.get(absolute);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.symbols;

  if (stat.size > MAX_FILE_BYTES) return [];
  let content: string;
  try {
    content = await fs.readFile(absolute, "utf8");
  } catch {
    return [];
  }
  if (content.includes("\u0000")) return []; // binary

  const symbols: SymbolHit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of patterns.rules) {
      const match = rule.re.exec(line);
      if (match) {
        symbols.push({ path: rel, line: i + 1, name: match[1].trim(), kind: rule.kind });
        break; // first matching rule wins for a line
      }
    }
  }

  cache.set(absolute, { mtimeMs: stat.mtimeMs, symbols });
  return symbols;
}

export async function workspaceSymbols(workspace: string, rawQuery: string): Promise<{ hits: SymbolHit[]; truncated: boolean }> {
  clearCacheIfWorkspaceChanged(workspace);
  const query = rawQuery.trim().toLowerCase();
  const hits: SymbolHit[] = [];
  let truncated = false;

  for await (const entry of walkWorkspace(workspace)) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.relative).toLowerCase();
    if (!patternsFor(ext)) continue;

    let fileSymbols: SymbolHit[];
    try {
      fileSymbols = await extractFromFile(entry.absolute, entry.relative, ext);
    } catch {
      continue;
    }
    if (fileSymbols.length === 0) continue;

    if (!query) {
      for (const s of fileSymbols) {
        if (hits.length >= MAX_RESULTS) { truncated = true; break; }
        hits.push(s);
      }
    } else {
      for (const s of fileSymbols) {
        if (s.name.toLowerCase().includes(query)) {
          if (hits.length >= MAX_RESULTS) { truncated = true; break; }
          hits.push(s);
        }
      }
    }
    if (truncated) break;
  }

  // Prefix matches first, then shorter names, then path order for stability.
  hits.sort((a, b) => {
    const aPrefix = query && a.name.toLowerCase().startsWith(query) ? 0 : 1;
    const bPrefix = query && b.name.toLowerCase().startsWith(query) ? 0 : 1;
    return aPrefix - bPrefix || a.name.length - b.name.length || a.path.localeCompare(b.path) || a.line - b.line;
  });

  return { hits: hits.slice(0, MAX_RESULTS), truncated };
}
