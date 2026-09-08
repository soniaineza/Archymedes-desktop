/**
 * Port of the CLI's workspace boundary (packages/core/src/cli/workspace.ts):
 * everything resolves to an absolute path inside the project root and refuses
 * to escape — including through `..` or an outward symlink.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type WorkspaceLimits = {
  maxReadBytes: number;
  maxWriteBytes: number;
  ignoredDirectories: readonly string[];
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxReadBytes: 512_000,
  maxWriteBytes: 512_000,
  ignoredDirectories: [".git", "node_modules", ".next", "dist", "build", "target", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", "vendor", ".archymedes", "coverage", "test-results", ".convex", ".wrangler"],
};

export class WorkspaceViolation extends Error {}

export async function realPathWithin(root: string, candidate: string): Promise<string> {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceViolation(`${candidate} is outside the project root`);
  }
  // An existing path's symlink chain must also stay inside the tree.
  try {
    const real = await fs.realpath(absolute);
    const realRelative = path.relative(root, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new WorkspaceViolation(`${candidate} resolves outside the project root through a symlink`);
    }
    return real;
  } catch (error) {
    if (error instanceof WorkspaceViolation) throw error;
    // Not found yet: the lexical check above is the answer we can give.
    return absolute;
  }
}

export function displayPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}

export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return sample.includes(0);
}

export type ReadResult = {
  path: string;
  content: string;
  startLine: number;
  totalLines: number;
  truncated: boolean;
};

export async function readTextFile(
  root: string,
  candidate: string,
  options: { offset?: number; limit?: number; limits?: WorkspaceLimits } = {},
): Promise<ReadResult> {
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const absolute = await realPathWithin(root, candidate);
  const stat = await fs.stat(absolute).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceViolation(`${displayPath(root, absolute)} does not exist`);
    throw error;
  });
  if (stat.isDirectory()) throw new WorkspaceViolation(`${displayPath(root, absolute)} is a directory, not a file`);
  if (stat.size > limits.maxReadBytes) {
    throw new WorkspaceViolation(`${displayPath(root, absolute)} is ${stat.size} bytes, above the ${limits.maxReadBytes}-byte read limit`);
  }
  const buffer = await fs.readFile(absolute);
  if (looksBinary(buffer)) throw new WorkspaceViolation(`${displayPath(root, absolute)} looks like a binary file`);

  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const startLine = Math.max(1, options.offset ?? 1);
  const limit = options.limit;
  if (startLine === 1 && limit === undefined) {
    return { path: displayPath(root, absolute), content: text, startLine: 1, totalLines: lines.length, truncated: false };
  }
  const slice = lines.slice(startLine - 1, limit === undefined ? undefined : startLine - 1 + limit);
  return {
    path: displayPath(root, absolute),
    content: slice.join("\n"),
    startLine,
    totalLines: lines.length,
    truncated: startLine > 1 || (limit !== undefined && startLine - 1 + limit < lines.length),
  };
}

export async function writeTextFile(root: string, candidate: string, content: string, limits = DEFAULT_WORKSPACE_LIMITS): Promise<{ path: string; bytesWritten: number }> {
  if (typeof content !== "string") throw new WorkspaceViolation("content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limits.maxWriteBytes) throw new WorkspaceViolation(`content is ${bytes} bytes, above the ${limits.maxWriteBytes}-byte write limit`);
  const absolute = await realPathWithin(root, candidate);
  await realPathWithin(root, path.dirname(candidate));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
  return { path: displayPath(root, absolute), bytesWritten: bytes };
}

/**
 * Replaces one exact occurrence of `oldText` — not a whole-file rewrite. A
 * model that must reproduce an entire file to change one line will eventually
 * reproduce it imperfectly, and the damage is silent.
 */
export async function editTextFile(
  root: string,
  candidate: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; limits?: WorkspaceLimits } = {},
): Promise<{ path: string; replacements: number }> {
  if (typeof oldText !== "string" || oldText === "") throw new WorkspaceViolation("oldText must be a non-empty string");
  if (typeof newText !== "string") throw new WorkspaceViolation("newText must be a string");
  if (oldText === newText) throw new WorkspaceViolation("oldText and newText are identical");

  const existing = await readTextFile(root, candidate, { limits: options.limits });
  const occurrences = existing.content.split(oldText).length - 1;
  if (occurrences === 0) throw new WorkspaceViolation(`oldText was not found in ${existing.path}`);
  if (occurrences > 1 && !options.replaceAll) {
    throw new WorkspaceViolation(`oldText appears ${occurrences} times in ${existing.path}; include more surrounding context or set replaceAll`);
  }
  const updated = options.replaceAll ? existing.content.split(oldText).join(newText) : existing.content.replace(oldText, newText);
  await writeTextFile(root, candidate, updated, options.limits ?? DEFAULT_WORKSPACE_LIMITS);
  return { path: existing.path, replacements: options.replaceAll ? occurrences : 1 };
}

export type WalkEntry = { absolute: string; relative: string; isDirectory: boolean };

const WALK_CONCURRENCY = 32;
const GREP_CONCURRENCY = 32;

export async function* walkWorkspace(root: string, limits = DEFAULT_WORKSPACE_LIMITS, maxEntries = 20_000): AsyncGenerator<WalkEntry> {
  const absoluteRoot = path.resolve(root);
  const ignored = new Set(limits.ignoredDirectories);
  let level: string[] = [absoluteRoot];
  let seen = 0;

  while (level.length > 0) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += WALK_CONCURRENCY) {
      const batch = level.slice(start, start + WALK_CONCURRENCY);
      const reads = await Promise.all(batch.map(async (directory): Promise<{ directory: string; entries: import("node:fs").Dirent[] }> => {
        try {
          return { directory, entries: await fs.readdir(directory, { withFileTypes: true }) };
        } catch {
          return { directory, entries: [] };
        }
      }));
      for (const { directory, entries } of reads) {
        for (const entry of entries) {
          if (seen >= maxEntries) return;
          const absolute = path.join(directory, entry.name);
          const isDirectory = entry.isDirectory();
          if (isDirectory && ignored.has(entry.name)) continue;
          seen += 1;
          yield { absolute, relative: displayPath(absoluteRoot, absolute), isDirectory };
          if (isDirectory) next.push(absolute);
        }
      }
    }
    level = next;
  }
}

/** Glob matching for `**`, `*`, `?` and `{a,b}` — no dependency, no regex surprises. */
export function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") { expression += "[^/]"; continue; }
    if (character === "{") {
      const close = pattern.indexOf("}", index);
      if (close > index) {
        expression += `(?:${pattern.slice(index + 1, close).split(",").map(escapeRegExp).join("|")})`;
        index = close;
        continue;
      }
    }
    expression += escapeRegExp(character);
  }
  return new RegExp(`^${expression}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function globWorkspace(root: string, pattern: string, limits = DEFAULT_WORKSPACE_LIMITS, maxResults = 500): Promise<string[]> {
  const matcher = globToRegExp(pattern);
  const matches: string[] = [];
  for await (const entry of walkWorkspace(root, limits)) {
    if (entry.isDirectory) continue;
    if (matcher.test(entry.relative)) matches.push(entry.relative);
    if (matches.length >= maxResults) break;
  }
  return matches.sort();
}

export type GrepMatch = { path: string; line: number; text: string };

/**
 * Content search across the workspace, read directly rather than shelling out
 * to ripgrep so behavior is identical on machines without `rg`.
 */
export async function grepWorkspace(
  root: string,
  query: string,
  options: { include?: string; regex?: boolean; maxResults?: number; limits?: WorkspaceLimits } = {},
): Promise<GrepMatch[]> {
  if (typeof query !== "string" || query === "") throw new WorkspaceViolation("query must be a non-empty string");
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const maxResults = options.maxResults ?? 200;
  const include = options.include ? globToRegExp(options.include) : null;
  const matcher = options.regex ? new RegExp(query) : null;
  const matches: GrepMatch[] = [];
  const literal = matcher ? null : Buffer.from(query, "utf8");

  const scan = async (entry: WalkEntry): Promise<GrepMatch[]> => {
    let buffer: Buffer;
    try {
      const stat = await fs.stat(entry.absolute);
      if (stat.size > limits.maxReadBytes) return [];
      buffer = await fs.readFile(entry.absolute);
    } catch {
      return [];
    }
    if (looksBinary(buffer)) return [];
    if (literal && buffer.indexOf(literal) === -1) return [];
    const found: GrepMatch[] = [];
    const lines = buffer.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (matcher ? matcher.test(lines[index]) : lines[index].includes(query)) {
        found.push({ path: entry.relative, line: index + 1, text: lines[index].slice(0, 400) });
        if (found.length >= maxResults) break;
      }
    }
    return found;
  };

  // Files read concurrently; matches appended in walk order so identical
  // searches of an unchanged tree return identical sequences.
  const batch: WalkEntry[] = [];
  const drain = async (): Promise<boolean> => {
    const scanned = await Promise.all(batch.splice(0, batch.length).map(scan));
    for (const fileMatches of scanned) {
      for (const match of fileMatches) {
        matches.push(match);
        if (matches.length >= maxResults) return true;
      }
    }
    return false;
  };

  for await (const entry of walkWorkspace(root, limits)) {
    if (entry.isDirectory) continue;
    if (include && !include.test(entry.relative)) continue;
    batch.push(entry);
    if (batch.length >= GREP_CONCURRENCY && await drain()) return matches;
  }
  await drain();
  return matches;
}
