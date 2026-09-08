import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@shared/types";

interface Props {
  sessions: SessionSummary[];
  currentId: string;
  currentTitle: string;
  dirtyFlag: number;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function SessionSwitcher({
  sessions, currentId, currentTitle, dirtyFlag, onSwitch, onNew, onRename, onDelete, onRefresh,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (dirtyFlag > 0) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyFlag]);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  return (
    <div className="session-switcher" ref={rootRef}>
      <button className="session-toggle" onClick={() => setOpen((o) => !o)} title="Chat sessions">
        <span className="session-title">{currentTitle}</span>
        <span className="chev">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="session-menu">
          <button className="session-new" onClick={() => { onNew(); setOpen(false); }}>
            ＋ new chat
          </button>
          {sessions.length === 0 && <div className="session-empty">No saved sessions yet</div>}
          {sessions.map((s) => (
            <div key={s.id} className={`session-row${s.id === currentId ? " current" : ""}`}>
              {editingId === s.id ? (
                <input
                  autoFocus
                  className="session-rename"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRename(s.id, editTitle);
                      setEditingId(null);
                    } else if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  onBlur={() => setEditingId(null)}
                />
              ) : (
                <>
                  <button className="session-open" onClick={() => { onSwitch(s.id); setOpen(false); }}>
                    <span className="name">{s.title}</span>
                    <span className="meta">{s.messageCount} msg · {timeAgo(s.updatedAt)}</span>
                  </button>
                  <button
                    className="session-action"
                    title="Rename"
                    onClick={() => { setEditingId(s.id); setEditTitle(s.title); }}
                  >
                    ✎
                  </button>
                  <button className="session-action delete" title="Delete" onClick={() => onDelete(s.id)}>
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
