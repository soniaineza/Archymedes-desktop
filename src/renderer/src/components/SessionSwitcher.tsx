import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@shared/types";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

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

// Sessions saved before localization used this literal as their default title.
const LEGACY_DEFAULT_TITLE = "New chat";

export function SessionSwitcher({
  sessions, currentId, currentTitle, dirtyFlag, onSwitch, onNew, onRename, onDelete, onRefresh,
}: Props) {
  const { t, formatRelativeTime } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (dirtyFlag > 0) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyFlag]);

  useEffect(() => {
    if (!open) return;
    onRefresh();
    setFilter("");
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  const displayTitle = (title: string) => (title && title !== LEGACY_DEFAULT_TITLE ? title : t("sessions.untitled"));
  const query = filter.trim().toLocaleLowerCase();
  const visible = query
    ? sessions.filter((s) => displayTitle(s.title).toLocaleLowerCase().includes(query))
    : sessions;

  const commitRename = (id: string) => {
    const next = editTitle.trim();
    if (next) onRename(id, next);
    setEditingId(null);
  };

  return (
    <div className="session-switcher" ref={rootRef}>
      <button
        className="session-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t("sessions.menu")}
      >
        <span className="session-title" dir="auto">
          {displayTitle(currentTitle)}
        </span>
        <Icon name="chevronDown" size={12} className="chev" />
      </button>

      {open && (
        <div className="session-menu popover" role="dialog" aria-label={t("sessions.menu")}>
          <div className="session-menu-top">
            <input
              className="input"
              autoFocus
              placeholder={t("sessions.filter")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className="btn primary small"
              onClick={() => {
                onNew();
                setOpen(false);
              }}
            >
              <Icon name="plus" size={13} />
              {t("sessions.new")}
            </button>
          </div>
          <div className="session-list">
            {visible.length === 0 && <div className="empty-note">{t("sessions.empty")}</div>}
            {visible.map((s) => (
              <div key={s.id} className={`session-row${s.id === currentId ? " current" : ""}`}>
                {editingId === s.id ? (
                  <input
                    className="input"
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(s.id);
                      else if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditingId(null);
                      }
                    }}
                    onBlur={() => commitRename(s.id)}
                  />
                ) : (
                  <>
                    <button
                      className="session-open"
                      onClick={() => {
                        onSwitch(s.id);
                        setOpen(false);
                      }}
                    >
                      <span className="name" dir="auto">
                        {displayTitle(s.title)}
                      </span>
                      <span className="meta">
                        {t("sessions.messages", { count: s.messageCount })} · {formatRelativeTime(s.updatedAt)}
                      </span>
                    </button>
                    <button
                      className="icon-btn"
                      title={t("common.rename")}
                      aria-label={t("common.rename")}
                      onClick={() => {
                        setEditingId(s.id);
                        setEditTitle(displayTitle(s.title));
                      }}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
                    <button
                      className={`icon-btn danger${confirmDeleteId === s.id ? " confirming" : ""}`}
                      title={confirmDeleteId === s.id ? t("sessions.deleteConfirm") : t("common.delete")}
                      aria-label={confirmDeleteId === s.id ? t("sessions.deleteConfirm") : t("common.delete")}
                      onClick={() => {
                        if (confirmDeleteId === s.id) {
                          onDelete(s.id);
                          setConfirmDeleteId(null);
                        } else {
                          setConfirmDeleteId(s.id);
                        }
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
