import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenTab } from "../lib/tabs";
import { fileName, isDirty } from "../lib/tabs";
import { highlightCode } from "./Highlight";

interface Props {
  tabs: OpenTab[];
  activeTab: string | null;
  activeLine?: number | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onSave: (path: string, content: string) => void;
  onChange: (path: string, content: string) => void;
}

function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "ts", jsx: "tsx", mjs: "ts", cjs: "ts",
    json: "json", css: "css", scss: "scss", html: "html", md: "md",
    rs: "rust", py: "python", yml: "yaml", yaml: "yaml", toml: "toml",
    sh: "bash", txt: "text",
  };
  return map[ext] ?? "text";
}

export function CodeEditor({ tabs, activeTab, activeLine, onActivate, onClose, onSave, onChange }: Props) {
  const active = tabs.find((t) => t.path === activeTab) ?? null;
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const hlRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const updateCursor = () => {
    const el = taRef.current;
    if (!el) return;
    const upTo = el.value.slice(0, el.selectionStart);
    const lines = upTo.split("\n");
    setCursor({ line: lines.length, col: (lines[lines.length - 1]?.length ?? 0) + 1 });
  };

  const syncScroll = () => {
    const el = taRef.current;
    if (!el) return;
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
    if (hlRef.current) {
      hlRef.current.scrollTop = el.scrollTop;
      hlRef.current.scrollLeft = el.scrollLeft;
    }
  };

  /** Wrap a selection transform on the textarea content. */
  const transform = (fn: (value: string, selStart: number, selEnd: number) => { value: string; selStart: number; selEnd: number }) => {
    const el = taRef.current;
    if (!el || !active) return;
    const res = fn(el.value, el.selectionStart, el.selectionEnd);
    onChange(active.path, res.value);
    setTimeout(() => {
      el.setSelectionRange(res.selStart, res.selEnd);
      updateCursor();
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Read-only (truncated) files: ignore editing transforms entirely.
    if (active?.truncated) return;
    const el = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (active && !active.truncated) onSave(active.path, active.content);
      return;
    }

    // Tab / Shift+Tab: indent or outdent
    if (e.key === "Tab") {
      e.preventDefault();
      const indent = "  ";
      if (el.selectionStart !== el.selectionEnd || e.shiftKey) {
        transform((value, s, selEnd) => {
          const lineStart = value.lastIndexOf("\n", s - 1) + 1;
          const lineEnd = value.indexOf("\n", selEnd) === -1 ? value.length : value.indexOf("\n", selEnd);
          const block = value.slice(lineStart, lineEnd);
          const lines = block.split("\n");
          const next = lines
            .map((l) => (e.shiftKey ? l.replace(/^ {1,2}|^\t/, "") : indent + l))
            .join("\n");
          return { value: value.slice(0, lineStart) + next + value.slice(lineEnd), selStart: lineStart, selEnd: lineStart + next.length };
        });
      } else {
        transform((value, s, selEnd) => ({
          value: value.slice(0, s) + indent + value.slice(selEnd),
          selStart: s + indent.length,
          selEnd: s + indent.length,
        }));
      }
      return;
    }

    // Auto-indent on Enter: copy leading whitespace, extra after { ( [ :
    if (e.key === "Enter") {
      e.preventDefault();
      transform((value, s, selEnd) => {
        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
        const currentLine = value.slice(lineStart, s);
        const indent = (/^[ \t]*/.exec(currentLine)?.[0]) ?? "";
        const opensBlock = /[{[(:]\s*$/.test(currentLine);
        const extra = opensBlock ? "  " : "";
        const insert = "\n" + indent + extra;
        // close the block on the next line if the user just opened it
        const nextChar = value[selEnd] ?? "";
        const closes = opensBlock && "})]".includes(nextChar);
        const out = value.slice(0, s) + insert + (closes ? "\n" + indent : "") + value.slice(selEnd);
        const caret = s + insert.length;
        return { value: out, selStart: caret, selEnd: caret };
      });
      return;
    }

    // Ctrl+/: toggle line comment
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      transform((value, s, selEnd) => {
        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
        const lineEnd = value.indexOf("\n", selEnd) === -1 ? value.length : value.indexOf("\n", selEnd);
        const block = value.slice(lineStart, lineEnd);
        const lines = block.split("\n");
        const allCommented = lines.every((l) => l.trim().length === 0 || l.trimStart().startsWith("//"));
        const next = lines
          .map((l) => (allCommented ? l.replace(/^(\s*)\/\/ ?/, "$1") : l.trim().length ? l.replace(/^(\s*)/, "$1// ") : l))
          .join("\n");
        return { value: value.slice(0, lineStart) + next + value.slice(lineEnd), selStart: s, selEnd: s };
      });
      return;
    }

    // Shift+Alt+Down/Up: duplicate line down/up
    if (e.shiftKey && e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      transform((value, s) => {
        const lineStart = value.lastIndexOf("\n", s - 1) + 1;
        const lineEnd = value.indexOf("\n", s) === -1 ? value.length : value.indexOf("\n", s);
        const line = value.slice(lineStart, lineEnd) + "\n";
        if (e.key === "ArrowDown") {
          return { value: value.slice(0, lineEnd) + line + value.slice(lineEnd), selStart: s + line.length, selEnd: s + line.length };
        }
        const prevStart = value.lastIndexOf("\n", lineStart - 2) + 1;
        return { value: value.slice(0, prevStart) + line + value.slice(prevStart, lineEnd) + value.slice(lineEnd), selStart: s, selEnd: s };
      });
      return;
    }
  };

  const lineCount = active ? active.content.split("\n").length : 0;
  const lang = active ? langOf(active.path) : "text";

  // Highlighting is the most expensive thing on every keystroke: memoize per
  // file content and skip entirely for truncated reads (where the textarea is
  // also read-only — editing only the visible half of a file would silently
  // discard the rest on save).
  const canEdit = !active?.truncated;
  const highlighted = useMemo(
    () => (active && canEdit ? highlightCode(active.content, lang) : null),
    [active?.path, active?.content, canEdit, lang],
  );

  // Escape closes the active tab when the editor has focus — quick file-hopping
  // without reaching for the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !active) return;
      const el = taRef.current;
      if (el && document.activeElement === el) {
        e.preventDefault();
        onClose(active.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

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
            {isDirty(tab) && <span className="dirty-dot">●</span>}
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
          <div className="editor-wrap">
            <div className="editor-gutter" ref={gutterRef}>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className={`ln${cursor.line === i + 1 ? " current" : ""}`}>
                  {i + 1}
                </div>
              ))}
            </div>
            <div className="editor-stack">
              <div className="editor-highlight" ref={hlRef} aria-hidden>
                {/* Current-line bar: translated to the caret line, scrolled in sync. */}
                <div className="current-line-bar" style={{ transform: `translateY(${(cursor.line - 1) * 20.8}px)` }} />
                <pre><code>{highlighted}</code></pre>
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
                className="editor-textarea transparent"
                value={active.content}
                readOnly={!canEdit}
                onChange={(e) => {
                  onChange(active.path, e.target.value);
                  setTimeout(updateCursor, 0);
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={updateCursor}
                onClick={() => { updateCursor(); syncScroll(); }}
                onScroll={syncScroll}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="editor-status">
            <span>{active.path}</span>
            {active.truncated && <span className="truncate-note" title="The file exceeds the editor's 512 KiB read cap. Editing is disabled so the hidden tail can't be lost on save.">(truncated — read-only)</span>}
            {isDirty(active) && <span className="dirty">● unsaved</span>}
            <span className="status-right">{lang} · Ln {cursor.line}, Col {cursor.col} · {lineCount} lines</span>
            <button onClick={() => onSave(active.path, active.content)} disabled={!isDirty(active) || !canEdit}>
              Save Ctrl+S
            </button>
          </div>
        </>
      ) : (
        <div className="editor-wrap">
          <div className="editor-empty">Ctrl+P quick open · Ctrl+/ comment · Tab indent · ask the agent on the right</div>
        </div>
      )}
    </div>
  );
}
