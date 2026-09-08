import fs from "node:fs/promises";
import path from "node:path";
import type { DiffLine, FileDiff } from "../shared/types";
import { writeFileEntry, readFileEntry } from "./workspace-store";

/**
 * Before/after snapshots for agent-written files, plus a real unified diff
 * (LCS-based) and revert. Snapshots live in userData/edits, keyed by a safe
 * hash of the relative path.
 */

const EDITS_DIR = "edits";

function editsDir(userDataPath: string): string {
  return path.join(userDataPath, EDITS_DIR);
}

function keyFor(relPath: string): string {
  return relPath.replace(/[^a-zA-Z0-9._-]/g, "__");
}

export async function snapshotBefore(
  userDataPath: string,
  relPath: string,
): Promise<void> {
  try {
    const before = (await readFileEntry(relPath)).content;
    const dir = editsDir(userDataPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, keyFor(relPath)), before, "utf8");
  } catch {
    // File didn't exist before — that's a "new file" edit; record emptiness.
    const dir = editsDir(userDataPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, keyFor(relPath)), "", "utf8");
  }
}

export async function getSnapshot(
  userDataPath: string,
  relPath: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(editsDir(userDataPath), keyFor(relPath)), "utf8");
  } catch {
    return null;
  }
}

// ---------- LCS diff ----------

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

export function computeDiff(before: string, after: string, capLines = 2000): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const table = lcsTable(a, b);

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "context", oldLine: oldNo, newLine: newNo, text: a[i] });
      i += 1; j += 1; oldNo += 1; newNo += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "del", oldLine: oldNo, text: a[i] });
      i += 1; oldNo += 1;
    } else {
      lines.push({ kind: "add", newLine: newNo, text: b[j] });
      j += 1; newNo += 1;
    }
  }
  while (i < a.length) {
    lines.push({ kind: "del", oldLine: oldNo, text: a[i] });
    i += 1; oldNo += 1;
  }
  while (j < b.length) {
    lines.push({ kind: "add", newLine: newNo, text: b[j] });
    j += 1; newNo += 1;
  }

  return lines.length > capLines ? lines.slice(0, capLines) : lines;
}

export async function diffFile(
  userDataPath: string,
  relPath: string,
): Promise<FileDiff | null> {
  const before = await getSnapshot(userDataPath, relPath);
  if (before === null) return null;
  let after: string;
  try {
    after = (await readFileEntry(relPath)).content;
  } catch {
    after = "";
  }
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  let added = 0;
  let removed = 0;
  for (const line of afterLines) if (!beforeLines.has(line)) added += 1;
  for (const line of beforeLines) if (!afterLines.has(line)) removed += 1;

  return {
    path: relPath,
    isNew: before === "" && after !== "",
    added,
    removed,
    lines: computeDiff(before, after),
  };
}

export async function revertFile(userDataPath: string, relPath: string): Promise<void> {
  const snapshot = await getSnapshot(userDataPath, relPath);
  if (snapshot === null) throw new Error(`No saved snapshot for ${relPath}`);
  await writeFileEntry(relPath, snapshot);
}

export interface EditSummary {
  path: string;
  added: number;
  removed: number;
}

/** All agent-edited files this workspace session, with quick stats. */
export async function listEdits(userDataPath: string): Promise<EditSummary[]> {
  const dir = editsDir(userDataPath);
  let keys: string[] = [];
  try {
    keys = await fs.readdir(dir);
  } catch {
    return [];
  }
  const summaries: EditSummary[] = [];
  for (const key of keys) {
    const relPath = key.replace(/__/g, "/");
    const diff = await diffFile(userDataPath, relPath);
    if (diff && (diff.added > 0 || diff.removed > 0)) {
      summaries.push({ path: relPath, added: diff.added, removed: diff.removed });
    }
  }
  summaries.sort((a, b) => b.added + b.removed - (a.added + a.removed));
  return summaries;
}
