import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { OpenTab } from "../lib/tabs";
import { fileName, isDirty } from "../lib/tabs";
import { fileKind } from "../lib/files";
import { highlightCode } from "./Highlight";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

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

type Transform = (value: string, selStart: number, selEnd: number) => { value: string; selStart: number; selEnd: number };

export function CodeEditor({ tabs, activeTab, activeLine, onActivate, onClose, onSave, onChange }: Props) {
  const { t, shortcut } = useI18n();
  const active = tabs.find((tab) => tab.path === activeTab) ?? null;
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const hlRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const updateCursor = () => {
    const el = taRef.current;
    if (!el) return;
    const lines = el.value.slice(0, el.selectionStart).split("\n");
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

  const transform = (fn: Transform) => {
    const el = taRef.current;
    if (!el || !active) return;
    const res = fn(el.value, el.selectionStart, el.selectionEnd);
    onChange(active.path, res.value);
    setTimeout(() => {
      el.setSelectionRange(res.selStart, res.selEnd);
      updateCursor();
    }, 0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (active) onSave(active.path, active.content);
      return;
    }

    // A truncated tab is read-only: edits here could never be saved in full.
    if (active?.truncated) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(active.path);
      }
      return;
    }

    if (e.key === "Escape" && active && isDirty(active)) {
      e.preventDefault();
      onClose(active.path);
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
          const next = value
            .slice(lineStart, lineEnd)
            .split("\n")
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
        const indent = /^[ \t]*/.exec(currentLine)?.[0] ?? "";
        const opensBlock = /[{[(:]\s*$/.test(currentLine);
        const insert = "\n" + indent + (opensBlock ? "  " : "");
        const closes = opensBlock && "})]".includes(value[selEnd] ?? "");
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
        const lines = value.slice(lineStart, lineEnd).split("\n");
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
    }
  };

  const lineCount = active ? active.content.split("\n").length : 0;
  const lang = active ? langOf(active.path) : "text";
  // Tokenizing is the editor's hot path; only recompute when file or text changes.
  const highlighted = useMemo(
    () => (active ? highlightCode(active.content, lang) : null),
    [active?.path, active?.content, lang],
  );

  return (
    <div className="editor">
      {tabs.length > 0 && (
        <div className="tabs" role="tablist">
          {tabs.map((tab) => {
            const selected = tab.path === activeTab;
            return (
              <div
                key={tab.path}
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={`tab${selected ? " active" : ""}`}
                onClick={() => onActivate(tab.path)}
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(tab.path);
                }}
                title={tab.path}
              >
                <Icon name="file" size={13} className={`tree-icon kind-${fileKind(tab.path)}`} />
                <bdi className="tab-name">{fileName(tab.path)}</bdi>
                {isDirty(tab) && <span className="dirty-dot" aria-label={t("editor.unsaved")} />}
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.path);
                  }}
                  title={t("editor.closeTab")}
                  aria-label={t("editor.closeTab")}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {active ? (
        <>
          <div className="editor-wrap" dir="ltr">
            <div className="editor-gutter" ref={gutterRef} aria-hidden>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className={`ln${cursor.line === i + 1 ? " current" : ""}`}>
                  {i + 1}
                </div>
              ))}
            </div>
            <div className="editor-stack">
              <div className="editor-highlight" ref={hlRef} aria-hidden>
                <pre>
                  <code>{highlighted}</code>
                </pre>
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
                readOnly={active.truncated === true}
                onChange={(e) => {
                  onChange(active.path, e.target.value);
                  setTimeout(updateCursor, 0);
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={updateCursor}
                onClick={() => {
                  updateCursor();
                  syncScroll();
                }}
                onScroll={syncScroll}
                spellCheck={false}
                aria-label={active.path}
              />
            </div>
          </div>
          <div className="editor-status">
            <bdi className="editor-path" dir="ltr">
              {active.path}
            </bdi>
            {active.truncated && <span className="pill warn">{t("editor.readonly")}</span>}
            {active.truncated && (
              <span className="pill warn">
                <Icon name="alert" size={11} />
                {t("editor.truncated")}
              </span>
            )}
            {isDirty(active) && <span className="pill">{t("editor.unsaved")}</span>}
            <span className="spacer" />
            <span>{lang}</span>
            <span>{t("editor.position", { line: cursor.line, col: cursor.col })}</span>
            <span>{t("editor.lines", { count: lineCount })}</span>
            <button className="btn small" onClick={() => onSave(active.path, active.content)} disabled={!isDirty(active)}>
              {t("common.save")}
              <kbd>{shortcut("mod+s")}</kbd>
            </button>
          </div>
        </>
      ) : (
        <div className="editor-empty">
          <Icon name="logo" size={44} className="editor-empty-mark" />
          <div className="editor-empty-title">{t("editor.emptyTitle")}</div>
          <div className="editor-empty-hint">{t("editor.emptyHint", { shortcut: shortcut("mod+p") })}</div>
        </div>
      )}
    </div>
  );
}
