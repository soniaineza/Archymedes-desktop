import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { useI18n } from "../i18n/I18nProvider";
import { fileKind } from "../lib/files";

interface Props {
  files: string[];
  onClose: () => void;
  onOpen: (path: string) => void;
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

export function QuickOpen({ files, onClose, onOpen }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => {
    return files
      .map((f) => ({ f, score: fuzzyMatch(query, f) }))
      .filter((x): x is { f: string; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
      .slice(0, 50)
      .map((x) => x.f);
  }, [files, query]);

  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onClose();
    onOpen(path);
  };

  return (
    <Modal onClose={onClose} position="top" className="palette" label={t("quickOpen.placeholder")}>
      <div className="palette-search">
        <Icon name="search" size={15} />
        <input
          autoFocus
          className="palette-input"
          placeholder={t("quickOpen.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pick(ranked[selected]);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, ranked.length - 1));
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
        {ranked.map((f, i) => {
          const slash = f.lastIndexOf("/");
          return (
            <div
              key={f}
              role="option"
              aria-selected={i === selected}
              className={`palette-item${i === selected ? " selected" : ""}`}
              onMouseMove={() => setSelected(i)}
              onClick={() => pick(f)}
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
        {ranked.length === 0 && <div className="empty-note padded">{t("quickOpen.empty")}</div>}
      </div>
    </Modal>
  );
}
