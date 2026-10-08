import { useMemo } from "react";
import { langFromPath, renderTokens, tokenizeLines } from "./Highlight";

/** One rendered diff row: VS Code-style old/new gutters, +/− sign and highlighted code. */
export interface DiffRow {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse unified diff text (as found in ```diff fences) into rows with line numbers. */
export function parseUnifiedDiff(text: string): { rows: DiffRow[]; path: string | null } {
  let oldNo = 0;
  let newNo = 0;
  let path: string | null = null;
  const rows: DiffRow[] = [];
  for (const line of text.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      const m = /^(?:\+\+\+|---)\s+(?:[ab]\/)?(\S+)/.exec(line);
      if (m && m[1] !== "/dev/null" && line.startsWith("+++")) path = m[1];
      else if (m && m[1] !== "/dev/null" && !path) path = m[1];
      rows.push({ kind: "meta", text: line });
    } else if (/^(?:diff |index |new file|deleted file|similarity|rename )/.test(line)) {
      rows.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newLine: newNo > 0 ? newNo++ : undefined });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldLine: oldNo > 0 ? oldNo++ : undefined });
    } else {
      const body = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({
        kind: "ctx",
        text: body,
        oldLine: oldNo > 0 ? oldNo++ : undefined,
        newLine: newNo > 0 ? newNo++ : undefined,
      });
    }
  }
  return { rows, path };
}

const SIGN: Record<DiffRow["kind"], string> = { add: "+", del: "−", ctx: " ", hunk: "", meta: "" };

export function DiffRows({ rows, lang, path }: { rows: readonly DiffRow[]; lang?: string; path?: string | null }) {
  const language = lang ?? (path ? langFromPath(path) : "text");
  const tokens = useMemo(
    () => tokenizeLines(rows.map((r) => (r.kind === "hunk" || r.kind === "meta" ? "" : r.text)), language),
    [rows, language],
  );
  const showNumbers = rows.some((r) => r.oldLine !== undefined || r.newLine !== undefined);
  return (
    <div className="diff-rows" dir="ltr">
      {rows.map((row, i) => (
        <div key={i} className={`diff-row ${row.kind}`}>
          {showNumbers && <span className="ln">{row.oldLine ?? ""}</span>}
          {showNumbers && <span className="ln">{row.newLine ?? ""}</span>}
          <span className="sign">{SIGN[row.kind]}</span>
          <span className="code">
            {row.kind === "hunk" || row.kind === "meta" ? row.text : renderTokens(tokens[i] ?? [])}
          </span>
        </div>
      ))}
    </div>
  );
}
