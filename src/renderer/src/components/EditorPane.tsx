import { useRef, useState } from "react";
import type { OpenTab } from "../lib/tabs";
import { fileName, isDirty } from "../lib/tabs";

interface Props {
  tabs: OpenTab[];
  activeTab: string | null;
  activeLine?: number | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onSave: (path: string, content: string) => void;
  onChange: (path: string, content: string) => void;
}

export function EditorPane({ tabs, activeTab, activeLine, onActivate, onClose, onSave, onChange }: Props) {
  const active = tabs.find((t) => t.path === activeTab) ?? null;
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const updateCursor = () => {
    const el = taRef.current;
    if (!el) return;
    const upTo = el.value.slice(0, el.selectionStart);
    const lines = upTo.split("\n");
    setCursor({ line: lines.length, col: (lines[lines.length - 1]?.length ?? 0) + 1 });
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
  };

  const lineCount = active ? active.content.split("\n").length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="tabs">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab${tab.path === activeTab ? " active" : ""}`}
            onClick={() => onActivate(tab.path)}
          >
            <span>{fileName(tab.path)}</span>
            {isDirty(tab) && <span style={{ color: "var(--white)" }}>●</span>}
            <button
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.path);
              }}
              title="Close tab"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {active ? (
        <>
          <div className="editor-wrap" style={{ position: "relative" }}>
            <div className="editor-gutter" ref={gutterRef}>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className={`ln${cursor.line === i + 1 ? " current" : ""}`}>
                  {i + 1}
                </div>
              ))}
            </div>
            <textarea
              key={`${active.path}:${activeLine ?? 0}`}
              ref={(el) => {
                taRef.current = el;
                if (el && activeLine && activeLine > 0) {
                  const lines = active.content.split("\n");
                  const pos = lines.slice(0, activeLine - 1).join("\n").length + (lines[activeLine - 1]?.length ?? 0);
                  el.focus();
                  el.setSelectionRange(pos, pos);
                }
              }}
              className="editor-textarea"
              value={active.content}
              onChange={(e) => {
                onChange(active.path, e.target.value);
                setTimeout(updateCursor, 0);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                  e.preventDefault();
                  onSave(active.path, active.content);
                }
              }}
              onKeyUp={updateCursor}
              onClick={updateCursor}
              onScroll={(e) => {
                if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              spellCheck={false}
            />
          </div>
          <div className="editor-status">
            <span>{active.path}</span>
            {active.truncated && <span>(truncated)</span>}
            {isDirty(active) && <span className="dirty">● unsaved</span>}
            <span style={{ marginLeft: "auto" }}>
              Ln {cursor.line}, Col {cursor.col} · {lineCount} lines
            </span>
            <button onClick={() => onSave(active.path, active.content)} disabled={!isDirty(active)}>
              Save Ctrl+S
            </button>
          </div>
        </>
      ) : (
        <div className="editor-wrap">
          <div className="editor-empty">Ctrl+P quick open · Ctrl+` terminal · ask the agent on the right</div>
        </div>
      )}
    </div>
  );
}
