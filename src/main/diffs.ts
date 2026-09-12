import type { DiffLine } from "../shared/types";

/** A line-based unified diff via longest common subsequence. Snapshots live in snapshots.ts. */

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
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
