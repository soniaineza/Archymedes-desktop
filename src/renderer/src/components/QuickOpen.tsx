import { useEffect, useMemo, useRef, useState } from "react";
import type { SymbolHit } from "@shared/types";

interface Props {
  files: string[];
  onClose: () => void;
  onOpen: (path: string, line?: number) => void;
}

const KIND_LABEL: Record<SymbolHit["kind"], string> = {
  function: "fn",
  class: "class",
  interface: "iface",
  type: "type",
  enum: "enum",
  struct: "struct",
  trait: "trait",
  impl: "impl",
};

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
  /** Null = file mode; string = symbol mode query (after the @). */
  const [symbolMode, setSymbolMode] = useState(false);
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<SymbolHit[]>([]);
  const [symbolsTruncated, setSymbolsTruncated] = useState(false);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Symbol search is debounced; the query is whatever follows the @.
  useEffect(() => {
    if (!symbolMode) return;
    const t = setTimeout(() => {
      setSymbolsLoading(true);
      void window.archymedes
        .workspaceSymbols(query.trim())
        .then((r) => {
          setSymbols(r.hits);
          setSymbolsTruncated(r.truncated);
        })
        .finally(() => setSymbolsLoading(false));
    }, 180);
    return () => clearTimeout(t);
  }, [symbolMode, query]);

  const ranked = useMemo(() => {
    if (symbolMode) return [];
    const scored = files
      .map((f) => ({ f, score: fuzzyMatch(query, f) }))
      .filter((x): x is { f: string; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
    return scored.slice(0, 40).map((x) => x.f);
  }, [files, query, symbolMode]);

  useEffect(() => setSelected(0), [query, symbolMode]);

  const pick = (path: string | undefined, line?: number) => {
    if (!path) return;
    onClose();
    onOpen(path, line);
  };

  const itemCount = symbolMode ? symbols.length : ranked.length;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "Enter") {
      e.preventDefault();
      if (symbolMode) pick(symbols[selected]?.path, symbols[selected]?.line);
      else pick(ranked[selected]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, itemCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
  };

  const onQueryChange = (next: string): void => {
    if (next.startsWith("@")) {
      setSymbolMode(true);
      setQuery(next.slice(1));
    } else {
      setSymbolMode(false);
      setQuery(next);
    }
  };

  return (
    <div className="modal-backdrop overlay-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search files by name…  (@prefix for symbols)"
          value={symbolMode ? `@${query}` : query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {symbolMode ? (
            <>
              {symbolsLoading && <div className="palette-empty">Scanning symbols…</div>}
              {!symbolsLoading && symbols.length === 0 && (
                <div className="palette-empty">{query ? "No matching symbols" : "Type to search functions, classes…"}</div>
              )}
              {symbols.map((s, i) => (
                <div
                  key={`${s.path}:${s.line}:${s.name}`}
                  className={`palette-item${i === selected ? " selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => pick(s.path, s.line)}
                >
                  <span className="symbol-row">
                    <span className={`sym-badge sym-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                    <span>{s.name}</span>
                  </span>
                  <span className="hint">{s.path}:{s.line}</span>
                </div>
              ))}
              {symbolsTruncated && <div className="palette-empty">Results capped — refine the query.</div>}
            </>
          ) : (
            <>
              {ranked.map((f, i) => (
                <div
                  key={f}
                  className={`palette-item${i === selected ? " selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => pick(f)}
                >
                  <span>{f.split("/").pop()}</span>
                  <span className="hint">{f}</span>
                </div>
              ))}
              {ranked.length === 0 && <div className="palette-empty">No matching files — try @ for symbols</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
