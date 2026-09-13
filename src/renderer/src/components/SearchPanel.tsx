import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchResult } from "@shared/types";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { useI18n } from "../i18n/I18nProvider";
import { fileKind } from "../lib/files";

interface Props {
  onOpenFile: (path: string, line?: number) => void;
  onClose: () => void;
}

const EMPTY: SearchResult = { truncated: false, hits: [] };

function highlight(text: string, query: string, caseSensitive = false) {
  const idx = query ? (caseSensitive ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase())) : -1;
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function SearchPanel({ onOpenFile, onClose }: Props) {
  const { t, formatNumber } = useI18n();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<SearchResult>(EMPTY);
  const [searching, setSearching] = useState(false);
  const requestRef = useRef(0);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setResult(EMPTY);
      setSearching(false);
      return;
    }
    const request = ++requestRef.current;
    setSearching(true);
    const timer = setTimeout(() => {
      window.archymedes
        .workspaceSearch(query, caseSensitive)
        .then((r) => {
          if (request === requestRef.current) setResult(r);
        })
        .catch(() => {
          if (request === requestRef.current) setResult(EMPTY);
        })
        .finally(() => {
          if (request === requestRef.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, trimmed, caseSensitive]);

  const byFile = useMemo(() => {
    const groups = new Map<string, SearchResult["hits"]>();
    for (const hit of result.hits) {
      const list = groups.get(hit.path) ?? [];
      list.push(hit);
      groups.set(hit.path, list);
    }
    return [...groups.entries()];
  }, [result]);

  return (
    <Modal onClose={onClose} position="top" className="palette search-palette" label={t("search.title")}>
      <div className="palette-search">
        <Icon name="search" size={15} />
        <input
          autoFocus
          className="palette-input"
          placeholder={t("search.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("search.title")}
        />
        {searching && <Icon name="loader" size={14} className="spin" />}
        <button
          className={`case-toggle${caseSensitive ? " on" : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          aria-pressed={caseSensitive}
          title={t("search.caseSensitive")}
        >
          Aa
        </button>
      </div>
      <div className="palette-list search-results" aria-live="polite">
        {trimmed.length < 2 && <div className="empty-note padded">{t("search.minChars")}</div>}
        {!searching && trimmed.length >= 2 && result.hits.length === 0 && (
          <div className="empty-note padded">{t("search.noResults")}</div>
        )}
        {byFile.map(([filePath, hits]) => (
          <div key={filePath} className="search-file">
            <div className="search-file-name">
              <Icon name="file" size={13} className={`tree-icon kind-${fileKind(filePath)}`} />
              <bdi dir="ltr">{filePath}</bdi>
              <span className="count-badge">{formatNumber(hits.length)}</span>
            </div>
            {hits.map((hit, i) => (
              <button key={i} className="search-hit" dir="ltr" onClick={() => onOpenFile(filePath, hit.line)}>
                <span className="line">{hit.line}</span>
                <span className="text">{highlight(hit.text, trimmed, result.caseSensitive === true)}</span>
              </button>
            ))}
          </div>
        ))}
        {result.truncated && (
          <div className="empty-note padded">{t("search.capped", { count: result.hits.length })}</div>
        )}
      </div>
    </Modal>
  );
}
