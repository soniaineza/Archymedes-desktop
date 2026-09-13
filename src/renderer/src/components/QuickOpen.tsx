import { useEffect, useMemo, useRef, useState } from "react";
import type { SymbolHit, SymbolKind } from "@shared/types";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { useI18n } from "../i18n/I18nProvider";
import { fileKind } from "../lib/files";

interface Props {
  files: string[];
  onClose: () => void;
  onOpen: (path: string) => void;
  /** Open a file scrolled to a 1-based line. */
  onOpenAtLine: (path: string, line: number) => void;
}

/** Subsequence match with a score: "apptx" finds "App.tsx". */
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

const KIND_CLASS: Record<SymbolKind, string> = {
  function: "fn",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  struct: "struct",
  trait: "trait",
  impl: "impl",
};

type Entry = { kind: "symbol"; s: SymbolHit; score: number } | { kind: "file"; f: string; score: number };

export function QuickOpen({ files, onClose, onOpen, onOpenAtLine }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // "@" switches to symbol mode; the prefix stays in the input until backspaced away.
  const symbolMode = query.startsWith("@");
  const symbolQuery = query.slice(1);
  const [symbols, setSymbols] = useState<SymbolHit[]>([]);
  const [symbolsTruncated, setSymbolsTruncated] = useState(false);

  useEffect(() => {
    if (!symbolMode) return;
    const timer = setTimeout(() => {
      window.archymedes
        .workspaceSymbols(symbolQuery)
        .then((r) => {
          setSymbols(r.hits);
          setSymbolsTruncated(r.truncated);
        })
        .catch(() => {
          setSymbols([]);
          setSymbolsTruncated(false);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [symbolMode, symbolQuery]);

  const ranked = useMemo((): Entry[] => {
    if (symbolMode) {
      const q = symbolQuery.toLowerCase();
      return symbols
        .map((s) => ({ kind: "symbol" as const, s, score: fuzzyMatch(q, s.name) ?? -1 }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length || a.s.path.localeCompare(b.s.path))
        .slice(0, 50);
    }
    return files
      .map((f) => ({ kind: "file" as const, f, score: fuzzyMatch(query, f) }))
      .filter((x): x is { kind: "file"; f: string; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
      .slice(0, 50);
  }, [files, query, symbolMode, symbolQuery, symbols]);

  const resultCount = ranked.length;

  useEffect(() => setSelected(0), [query, symbols]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pick = (target: Entry | undefined) => {
    if (!target) return;
    onClose();
    if (target.kind === "symbol") onOpenAtLine(target.s.path, target.s.line);
    else onOpen(target.f);
  };

  return (
    <Modal onClose={onClose} position="top" className="palette" label={t("quickOpen.placeholder")}>
      <div className="palette-search">
        <Icon name={symbolMode ? "command" : "search"} size={15} />
        <input
          autoFocus
          className="palette-input"
          placeholder={symbolMode ? t("symbols.placeholder") : t("quickOpen.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pick(ranked[selected]);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, resultCount - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            }
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-list"
        />
      </div>
      <div className="palette-list" id="quick-open-list" role="listbox" ref={listRef}>
        {symbolMode
          ? ranked.map((entry, i) => {
              if (entry.kind !== "symbol") return null;
              const s = entry.s;
              const slash = s.path.lastIndexOf("/");
              return (
                <div
                  key={`${s.path}:${s.line}:${s.name}`}
                  role="option"
                  aria-selected={i === selected}
                  className={`palette-item${i === selected ? " selected" : ""}`}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => pick(entry)}
                >
                  <span className={`symbol-badge kind-${KIND_CLASS[s.kind]}`}>{s.kind.slice(0, 3)}</span>
                  <bdi className="palette-primary" dir="ltr">
                    {s.name}
                  </bdi>
                  <bdi className="palette-hint" dir="ltr">
                    {s.path.slice(slash + 1)}:{s.line}
                  </bdi>
                </div>
              );
            })
          : ranked.map((entry, i) => {
              if (entry.kind !== "file") return null;
              const f = entry.f;
              const slash = f.lastIndexOf("/");
              return (
                <div
                  key={f}
                  role="option"
                  aria-selected={i === selected}
                  className={`palette-item${i === selected ? " selected" : ""}`}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => pick(entry)}
                >
                  <Icon name="file" size={14} className={`tree-icon kind-${fileKind(f)}`} />
                  <bdi className="palette-primary" dir="ltr">
                    {f.slice(slash + 1)}
                  </bdi>
                  {slash > 0 && (
                    <bdi className="palette-hint" dir="ltr">
                      {f.slice(0, slash)}
                    </bdi>
                  )}
                </div>
              );
            })}
        {resultCount === 0 && (
          <div className="empty-note padded">{symbolMode ? t("symbols.empty") : t("quickOpen.empty")}</div>
        )}
        {symbolMode && symbolsTruncated && <div className="empty-note padded">{t("search.capped", { count: symbols.length })}</div>}
      </div>
    </Modal>
  );
}
