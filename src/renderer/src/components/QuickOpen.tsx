import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  files: string[];
  onClose: () => void;
  onOpen: (path: string) => void;
}

/** Subsequence match with a score — "apptx" finds "App.tsx". */
function fuzzyMatch(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIdx = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      score += ti === lastIdx + 1 ? 3 : 1;
      if (ti === 0 || t[ti - 1] === "/" || t[ti - 1] === ".") score += 2;
      lastIdx = ti;
      qi += 1;
    }
  }
  return qi === q.length ? score : null;
}

export function QuickOpen({ files, onClose, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ranked = useMemo(() => {
    const scored = files
      .map((f) => ({ f, score: fuzzyMatch(query, f) }))
      .filter((x): x is { f: string; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
    return scored.slice(0, 40).map((x) => x.f);
  }, [files, query]);

  useEffect(() => setSelected(0), [query]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onClose();
    onOpen(path);
  };

  return (
    <div className="modal-backdrop overlay-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search files by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter") pick(ranked[selected]);
            else if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, ranked.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
          }}
        />
        <div className="palette-list">
          {ranked.map((f, i) => (
            <div key={f} className={`palette-item${i === selected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(i)} onClick={() => pick(f)}>
              <span>{f.split("/").pop()}</span>
              <span className="hint">{f}</span>
            </div>
          ))}
          {ranked.length === 0 && <div className="palette-empty">No matching files</div>}
        </div>
      </div>
    </div>
  );
}
