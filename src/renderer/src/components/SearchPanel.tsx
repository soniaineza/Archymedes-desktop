import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@shared/types";

interface Props {
  onOpenFile: (path: string, line?: number) => void;
  onClose: () => void;
}

export function SearchPanel({ onOpenFile, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>({ truncated: false, hits: [] });
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResult({ truncated: false, hits: [] });
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      void window.archymedes.workspaceSearch(query).then((r) => {
        setResult(r);
        setSearching(false);
      });
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Group hits by file.
  const byFile = new Map<string, SearchResult["hits"]>();
  for (const hit of result.hits) {
    const list = byFile.get(hit.path) ?? [];
    list.push(hit);
    byFile.set(hit.path, list);
  }

  return (
    <div className="search-panel">
      <div className="search-header">
        <span>Search workspace</span>
        <button className="close" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Find in files…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="search-results">
        {searching && <div className="search-note">Searching…</div>}
        {!searching && query.trim().length >= 2 && result.hits.length === 0 && (
          <div className="search-note">No results</div>
        )}
        {[...byFile.entries()].map(([filePath, hits]) => (
          <div key={filePath} className="search-file">
            <div className="search-file-name">{filePath} <span className="count">{hits.length}</span></div>
            {hits.map((hit, i) => (
              <div
                key={i}
                className="search-hit"
                onClick={() => onOpenFile(filePath, hit.line)}
              >
                <span className="line">{hit.line}</span>
                <span className="text">{hit.text}</span>
              </div>
            ))}
          </div>
        ))}
        {result.truncated && (
          <div className="search-note">Results capped at 200 — refine your query.</div>
        )}
      </div>
    </div>
  );
}
