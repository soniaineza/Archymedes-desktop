import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "xterm/css/xterm.css";
import { getTheme, resolveTheme } from "../lib/theme";
import type { ResolvedTheme } from "../lib/theme";
import type { TerminalShellChoice } from "@shared/types";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";

// ─── Types ────────────────────────────────────────────────────────────────

interface XtermColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

const TERM_COLORS: Record<ResolvedTheme, XtermColors> = {
  dark: { background: "#0b0b0d", foreground: "#e6e6e9", cursor: "#ffffff", selectionBackground: "#3a3a44" },
  light: { background: "#ffffff", foreground: "#1c1c21", cursor: "#1c1c21", selectionBackground: "#c9d4e6" },
  "solarized-dark": { background: "#002b36", foreground: "#dcdccc", cursor: "#fdf6e3", selectionBackground: "#1c5a6a" },
  "solarized-light": { background: "#fdf6e3", foreground: "#073642", cursor: "#002b36", selectionBackground: "#c9c0a5" },
  "high-contrast": { background: "#000000", foreground: "#ffffff", cursor: "#ffffff", selectionBackground: "#888888" },
};

const SHELL_MENU: { choice: TerminalShellChoice; icon: IconName; labelKey: MessageKey }[] = [
  { choice: "default", icon: "terminal", labelKey: "terminal.shellDefault" },
  { choice: "powershell", icon: "terminal", labelKey: "terminal.shellPowershell" },
  { choice: "cmd", icon: "terminal", labelKey: "terminal.shellCmd" },
  { choice: "gitbash", icon: "terminal", labelKey: "terminal.shellGitBash" },
  { choice: "custom", icon: "sliders", labelKey: "terminal.shellCustom" },
];

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 36;
const DEFAULT_FONT_SIZE = 12.5;

export interface TermEntry {
  id: number;
  ptyId: string | null;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  webLinks: WebLinksAddon;
  exited: boolean;
  shellChoice: TerminalShellChoice;
  shellLabel: string | null;
  title: string;
  fontSize: number;
  dispose: () => void;
}

export type SplitDirection = "right" | "down";

export interface TermGroup {
  id: number;
  type: "terminals";
  children: TermEntry[];
  activeIndex: number;
  direction?: never;
}

export interface SplitNode {
  id: number;
  type: "split";
  direction: "right" | "down";
  ratio: number;
  first: TermGroup | SplitNode;
  second: TermGroup | SplitNode;
}

export type LayoutNode = TermGroup | SplitNode;

interface Props {
  workspace: string;
  collapsed: boolean;
  height: number;
  onToggleCollapsed: () => void;
  onFileChange: () => void;
}

// ─── Find Bar ─────────────────────────────────────────────────────────────

interface FindBarProps {
  search: SearchAddon;
  onClose: () => void;
}

function FindBar({ search, onClose }: FindBarProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [matchInfo, setMatchInfo] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const off = search.onDidChangeResults((e: { resultIndex: number; resultCount: number }) => {
      setMatchInfo({ current: e.resultIndex, total: e.resultCount });
    });
    return () => { off.dispose(); };
  }, [search]);

  const doSearch = useCallback(
    (q: string) => {
      setQuery(q);
      if (!q) {
        search.clearDecorations();
        setMatchInfo({ current: 0, total: 0 });
        return;
      }
      search.findNext(q);
    },
    [search],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      if (e.shiftKey) search.findPrevious(query);
      else search.findNext(query);
    }
  };

  return (
    <div className="term-find-bar">
      <input
        ref={inputRef}
        className="input mono term-find-input"
        placeholder={t("terminal.findPlaceholder")}
        value={query}
        onChange={(e) => doSearch(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="term-find-count">
        {query && matchInfo.total > 0
          ? t("terminal.findMatchCount", { current: matchInfo.current + 1, total: matchInfo.total })
          : query
            ? t("terminal.findNoMatch")
            : ""}
      </span>
      <button className="icon-btn" onClick={() => { if (query) search.findPrevious(query); }} title={t("terminal.findPrev")} aria-label={t("terminal.findPrev")}>
        <Icon name="chevronRight" size={12} flipRtl />
      </button>
      <button className="icon-btn" onClick={() => { if (query) search.findNext(query); }} title={t("terminal.findNext")} aria-label={t("terminal.findNext")}>
        <Icon name="chevronDown" size={12} />
      </button>
      <button className="icon-btn" onClick={onClose} title={t("terminal.findClose")} aria-label={t("terminal.findClose")}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

// ─── Tab Context Menu ─────────────────────────────────────────────────────

interface ContextMenuProps {
  entry: TermEntry;
  allEntries: TermEntry[];
  position: { x: number; y: number };
  onClose: () => void;
  onRename: (id: number, title: string) => void;
  onClear: (id: number) => void;
  onKill: (id: number) => void;
  onSplit: (id: number, dir: SplitDirection) => void;
  onFontSize: (id: number, delta: number) => void;
  onFind: () => void;
  onSelectAll: () => void;
  onCopy: () => void;
}

function TabContextMenu({ entry, position, onClose, onRename, onClear, onKill, onSplit, onFontSize, onFind, onSelectAll, onCopy }: ContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="term-context-menu popover"
      style={{ position: "fixed", left: position.x, top: position.y, zIndex: 100 }}
    >
      <button onClick={() => { onFind(); onClose(); }}>
        <Icon name="search" size={13} />
        {t("terminal.find")}
      </button>
      <button onClick={() => { onSelectAll(); onClose(); }}>
        <Icon name="file" size={13} />
        {t("terminal.selectText")}
      </button>
      <button onClick={() => { onCopy(); onClose(); }}>
        <Icon name="copy" size={13} />
        {t("terminal.copySelection")}
      </button>
      <div className="ctx-separator" />
      <button onClick={() => { const name = prompt(t("terminal.rename"), entry.title); if (name !== null) { onRename(entry.id, name); } onClose(); }}>
        <Icon name="pencil" size={13} />
        {t("terminal.rename")}
      </button>
      <button onClick={() => { onClear(entry.id); onClose(); }}>
        <Icon name="x" size={13} />
        {t("terminal.clear")}
      </button>
      <div className="ctx-separator" />
      <button onClick={() => { onSplit(entry.id, "right"); onClose(); }}>
        <Icon name="splitV" size={13} />
        {t("terminal.splitRight")}
      </button>
      <button onClick={() => { onSplit(entry.id, "down"); onClose(); }}>
        <Icon name="splitH" size={13} />
        {t("terminal.splitDown")}
      </button>
      <div className="ctx-separator" />
      <button onClick={() => { onFontSize(entry.id, 1); onClose(); }}>
        <Icon name="plus" size={13} />
        {t("terminal.fontSizeUp")}
      </button>
      <button onClick={() => { onFontSize(entry.id, -1); onClose(); }}>
        <Icon name="minus" size={13} />
        {t("terminal.fontSizeDown")}
      </button>
      <button onClick={() => { onFontSize(entry.id, 0); onClose(); }}>
        <Icon name="refresh" size={13} />
        {t("terminal.fontSizeReset")}
      </button>
      <div className="ctx-separator" />
      <button className="danger" onClick={() => { onKill(entry.id); onClose(); }}>
        <Icon name="stop" size={13} />
        {t("terminal.killProcess")}
      </button>
    </div>
  );
}

// ─── Terminal Panel ───────────────────────────────────────────────────────

let nextId = 1;

export function TerminalPanel({ workspace, collapsed, height, onToggleCollapsed, onFileChange }: Props) {
  const { t, formatNumber } = useI18n();

  // Layout state: a single root group
  const [groups, setGroups] = useState<TermGroup[]>(() => [{ id: 0, type: "terminals", children: [], activeIndex: 0 }]);
  const [tick, setTick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [findBarEntry, setFindBarEntry] = useState<TermEntry | null>(null);
  const [contextMenu, setContextMenu] = useState<{ entry: TermEntry; x: number; y: number } | null>(null);
  const [activeGroupId, setActiveGroupId] = useState(0);
  const [tabTitles, setTabTitles] = useState<Map<number, string>>(new Map());

  const menuRef = useRef<HTMLDivElement>(null);
  const hostRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const termsRef = useRef<Map<number, TermEntry>>(new Map());
  const pendingChoiceRef = useRef<Map<number, TerminalShellChoice>>(new Map());
  const activeGroupIdRef = useRef(activeGroupId);
  const tRef = useRef(t);
  activeGroupIdRef.current = activeGroupId;
  tRef.current = t;

  // ── Terminals map for all groups ──
  const allEntries = useMemo(() => Array.from(termsRef.current.values()), [tick]);

  // ── Close context menu / find bar on outside click ──
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // ── Close context menu on click outside ──
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // ── Create a terminal ──
  const createTermEntry = useCallback(
    (_groupId: number, shellChoice: TerminalShellChoice): TermEntry => {
      const id = nextId++;
      const term = new Terminal({
        fontSize: DEFAULT_FONT_SIZE,
        fontFamily: '"Cascadia Code", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
        theme: TERM_COLORS[resolveTheme(getTheme())],
        cursorBlink: true,
        allowProposedApi: false,
        scrollback: 10000,
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      const webLinks = new WebLinksAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(webLinks);

      // Bell notification
      term.onBell(() => {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("Archymedes", { body: t("terminal.bell"), silent: true });
        }
      });

      const entry: TermEntry = {
        id,
        ptyId: null,
        term,
        fit,
        search,
        webLinks,
        exited: false,
        shellChoice,
        shellLabel: null,
        title: "",
        fontSize: DEFAULT_FONT_SIZE,
        dispose: () => {
          term.dispose();
        },
      };

      termsRef.current.set(id, entry);

      // Spawn PTY
      let disposed = false;
      void window.archymedes.createTerminal(undefined, shellChoice).then((info) => {
        if (disposed) return;
        entry.ptyId = info.id;
        entry.shellLabel = info.shellLabel ?? null;
        entry.title = info.shellLabel ?? t("terminal.shell", { n: formatNumber(id) });
        if (info.warning) term.write(`\x1b[33m⚠ ${info.warning}\x1b[0m\r\n`);
        window.archymedes.terminalResize(info.id, term.cols, term.rows);
        setTick((n) => n + 1);
      });

      const offData = window.archymedes.onTerminalData((ptyDataId, data) => {
        if (entry.ptyId && ptyDataId === entry.ptyId) term.write(data);
      });
      const offExit = window.archymedes.onTerminalExit((ptyDataId) => {
        if (entry.ptyId && ptyDataId === entry.ptyId) {
          entry.exited = true;
          term.write(`\r\n\x1b[90m${tRef.current("terminal.exited")}\x1b[0m\r\n`);
          setTick((n) => n + 1);
        }
      });
      const dataHandler = term.onData((data) => {
        if (!entry.ptyId) return;
        window.archymedes.terminalWrite(entry.ptyId, data);
        if (data === "\r") setTimeout(onFileChange, 800);
      });

      const origDispose = entry.dispose;
      entry.dispose = () => {
        disposed = true;
        offData();
        offExit();
        dataHandler.dispose();
        origDispose();
      };

      return entry;
    },
    [onFileChange, t, formatNumber],
  );

  // ── Attach term to DOM ──
  const attachTerm = useCallback((entry: TermEntry, groupId: number) => {
    const host = hostRefs.current.get(groupId);
    if (!host) return;
    host.innerHTML = "";
    if (entry.term.element) {
      host.appendChild(entry.term.element);
    } else {
      entry.term.open(host);
    }
    try {
      entry.fit.fit();
    } catch {
      // hidden
    }
    entry.term.focus();
  }, []);

  // ── Create initial terminal for first group ──
  useEffect(() => {
    if (collapsed) return;
    const firstGroup = groups[0];
    if (!firstGroup || firstGroup.children.length > 0) return;

    const shellChoice = pendingChoiceRef.current.get(firstGroup.id) ?? "default";
    const entry = createTermEntry(firstGroup.id, shellChoice);
    firstGroup.children.push(entry);
    firstGroup.activeIndex = 0;
    setTick((n) => n + 1);
    pendingChoiceRef.current.delete(firstGroup.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, workspace]);

  // ── Fit active terminals on resize ──
  useEffect(() => {
    const onResize = () => {
      for (const entry of termsRef.current.values()) {
        try {
          entry.fit.fit();
          if (entry.ptyId) window.archymedes.terminalResize(entry.ptyId, entry.term.cols, entry.term.rows);
        } catch {
          // hidden
        }
      }
    };
    window.addEventListener("resize", onResize);

    const observers: ResizeObserver[] = [];
    for (const [groupId, host] of hostRefs.current.entries()) {
      const obs = new ResizeObserver(() => {
        const group = groups.find((g) => g.id === groupId);
        if (!group) return;
        const active = group.children[group.activeIndex];
        if (active) {
          try {
            active.fit.fit();
            if (active.ptyId) window.archymedes.terminalResize(active.ptyId, active.term.cols, active.term.rows);
          } catch { /* hidden */ }
        }
      });
      obs.observe(host);
      observers.push(obs);
    }

    return () => {
      window.removeEventListener("resize", onResize);
      observers.forEach((o) => o.disconnect());
    };
  }, [groups, tick]);

  // ── Focus active terminal on active group change ──
  useEffect(() => {
    if (collapsed) return;
    const group = groups.find((g) => g.id === activeGroupId);
    if (!group) return;
    const active = group.children[group.activeIndex];
    if (active) attachTerm(active, group.id);
  }, [activeGroupId, collapsed, groups, tick, attachTerm]);

  // ── Global keyboard shortcut: focus terminal ──
  useEffect(() => {
    const onFocusRequest = () => {
      const group = groups.find((g) => g.id === activeGroupIdRef.current);
      if (!group) return;
      const active = group.children[group.activeIndex];
      if (active) active.term.focus();
    };
    document.addEventListener("focus-terminal", onFocusRequest);
    return () => document.removeEventListener("focus-terminal", onFocusRequest);
  }, [groups, activeGroupId]);

  // ── Theme changes ──
  useEffect(() => {
    const onTheme = (e: Event) => {
      const colors = TERM_COLORS[(e as CustomEvent<ResolvedTheme>).detail];
      if (colors) {
        for (const entry of termsRef.current.values()) {
          entry.term.options.theme = colors;
        }
      }
    };
    window.addEventListener("archymedes-theme", onTheme);
    return () => window.removeEventListener("archymedes-theme", onTheme);
  }, []);

  // ── Global keyboard shortcuts for terminal ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        changeFontSizeAll(1);
      } else if (e.key === "-") {
        e.preventDefault();
        changeFontSizeAll(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        changeFontSizeAll(0);
      } else if (e.key === "f" && e.ctrlKey && document.activeElement?.closest?.(".terminal-body")) {
        e.preventDefault();
        const group = groups.find((g) => g.id === activeGroupIdRef.current);
        if (group) {
          const active = group.children[group.activeIndex];
          if (active) setFindBarEntry(active);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      for (const entry of termsRef.current.values()) entry.dispose();
      termsRef.current.clear();
    };
  }, []);

  // ── Actions ──

  const changeFontSizeAll = (delta: number) => {
    for (const entry of termsRef.current.values()) {
      const newSize = delta === 0 ? DEFAULT_FONT_SIZE : Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, entry.fontSize + delta));
      entry.fontSize = newSize;
      entry.term.options.fontSize = newSize;
      try { entry.fit.fit(); } catch { /* hidden */ }
    }
    setTick((n) => n + 1);
  };

  const changeFontSize = (entryId: number, delta: number) => {
    const entry = termsRef.current.get(entryId);
    if (!entry) return;
    const newSize = delta === 0 ? DEFAULT_FONT_SIZE : Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, entry.fontSize + delta));
    entry.fontSize = newSize;
    entry.term.options.fontSize = newSize;
    try { entry.fit.fit(); } catch { /* hidden */ }
    setTick((n) => n + 1);
  };

  const addTab = (choice: TerminalShellChoice) => {
    const newGroup: TermGroup = { id: nextId++, type: "terminals", children: [], activeIndex: 0 };
    const entry = createTermEntry(newGroup.id, choice);
    newGroup.children.push(entry);
    newGroup.activeIndex = 0;
    setGroups((gs) => [...gs, newGroup]);
    setActiveGroupId(newGroup.id);
    setMenuOpen(false);
  };

  const closeTab = (entryId: number) => {
    const entry = termsRef.current.get(entryId);
    if (entry?.ptyId) window.archymedes.terminalKill(entry.ptyId);
    entry?.dispose();
    termsRef.current.delete(entryId);

    setGroups((gs) => {
      return gs
        .map((g) => {
          const idx = g.children.findIndex((c) => c.id === entryId);
          if (idx === -1) return g;
          const next = g.children.filter((c) => c.id !== entryId);
          return {
            ...g,
            children: next,
            activeIndex: Math.min(g.activeIndex, Math.max(0, next.length - 1)),
          };
        })
        .filter((g) => g.children.length > 0);
    });
    setTick((n) => n + 1);
  };

  const respawnTab = (entryId: number) => {
    const entry = termsRef.current.get(entryId);
    if (!entry?.exited) return;
    entry.dispose();
    termsRef.current.delete(entryId);
    pendingChoiceRef.current.set(entryId, entry.shellChoice);
    setTick((n) => n + 1);
  };

  const renameEntry = (entryId: number, title: string) => {
    setTabTitles((prev) => {
      const next = new Map(prev);
      next.set(entryId, title);
      return next;
    });
    setTick((n) => n + 1);
  };

  const clearTerminal = (entryId: number) => {
    const entry = termsRef.current.get(entryId);
    if (entry) entry.term.clear();
  };

  const killProcess = (entryId: number) => {
    const entry = termsRef.current.get(entryId);
    if (entry?.ptyId) window.archymedes.terminalKill(entry.ptyId);
  };

  const handleSplit = (entryId: number, dir: SplitDirection) => {
    const sourceEntry = termsRef.current.get(entryId);
    if (!sourceEntry) return;
    const newEntry = createTermEntry(activeGroupId, sourceEntry.shellChoice);
    setGroups((gs) => {
      // Find the group containing this entry
      const groupIdx = gs.findIndex((g) => g.children.some((c) => c.id === entryId));
      if (groupIdx === -1) return gs;
      const group = gs[groupIdx];
      const entryIdx = group.children.findIndex((c) => c.id === entryId);
      // Create a new group with the new entry
      const newGroup: TermGroup = { id: nextId++, type: "terminals", children: [newEntry], activeIndex: 0 };
      // Replace the group at groupIdx with a split containing two groups
      const leftGroup: TermGroup = {
        ...group,
        children: group.children.filter((c) => c.id !== entryId),
        activeIndex: Math.max(0, Math.min(entryIdx, group.children.length - 2)),
      };
      if (leftGroup.children.length === 0) {
        leftGroup.children = [sourceEntry];
        leftGroup.activeIndex = 0;
      }
      const split: SplitNode = {
        id: nextId++,
        type: "split",
        direction: dir,
        ratio: 0.5,
        first: leftGroup,
        second: newGroup,
      };
      return [...gs.slice(0, groupIdx), split as unknown as TermGroup, ...gs.slice(groupIdx + 1)];
    });
    setTick((n) => n + 1);
  };

  const respawnEntry = (entryId: number) => {
    respawnTab(entryId);
  };

  // ── Render ──

  const getTabLabel = (entry: TermEntry) => {
    const customTitle = tabTitles.get(entry.id);
    if (customTitle) return customTitle;
    const fallbackKey = SHELL_MENU.find((m) => m.choice === entry.shellChoice)?.labelKey ?? "terminal.shellDefault";
    return entry.shellLabel ?? t(fallbackKey);
  };

  return (
    <section
      className={`terminal-panel${collapsed ? " collapsed" : ""}`}
      style={collapsed ? undefined : { height }}
      aria-label={t("terminal.title")}
    >
      <div className="terminal-chrome">
        <button className="terminal-toggle" onClick={onToggleCollapsed} aria-expanded={!collapsed}>
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} flipRtl />
          <Icon name="terminal" size={13} />
          <span>{t("terminal.title")}</span>
        </button>
        {!collapsed && (
          <div className="term-tabs" role="tablist">
            {groups.map((group) =>
              group.children.map((entry) => (
                <div
                  key={entry.id}
                  role="tab"
                  aria-selected={group.id === activeGroupId}
                  tabIndex={group.id === activeGroupId ? 0 : -1}
                  className={`term-tab${group.id === activeGroupId ? " active" : ""}${entry.exited ? " exited" : ""}`}
                  onClick={() => {
                    setActiveGroupId(group.id);
                    setGroups((gs) => gs.map((g) => g.id === group.id ? { ...g, activeIndex: g.children.indexOf(entry) } : g));
                  }}
                  onDoubleClick={() => {
                    if (entry.exited) respawnEntry(entry.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ entry, x: e.clientX, y: e.clientY });
                  }}
                  title={entry.exited ? t("terminal.respawnHint") : undefined}
                >
                  <span className="term-tab-label">
                    {t("terminal.shell", { n: formatNumber(entry.id) })}
                    <span className="term-shell-badge">{getTabLabel(entry)}</span>
                    {entry.exited && <span className="term-exited-dot" />}
                  </span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(entry.id);
                    }}
                    aria-label={t("terminal.close")}
                    title={t("terminal.close")}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              )),
            )}
            <div className="term-add-wrap" ref={menuRef}>
              <button
                className="icon-btn"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={t("terminal.new")}
                aria-label={t("terminal.new")}
              >
                <Icon name="plus" size={14} />
              </button>
              {menuOpen && (
                <div className="term-shell-menu popover" role="menu">
                  {SHELL_MENU.map((item) => (
                    <button key={item.choice} role="menuitem" onClick={() => addTab(item.choice)}>
                      <Icon name={item.icon} size={13} />
                      {t(item.labelKey)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="term-body-wrapper">
          {findBarEntry && (
            <FindBar
              search={findBarEntry.search}
              onClose={() => setFindBarEntry(null)}
            />
          )}
          <div className="terminal-body">
            {groups.map((group) => (
              <div
                key={group.id}
                className={`term-group${group.id === activeGroupId ? " active" : ""}`}
                ref={(el) => {
                  if (el) hostRefs.current.set(group.id, el);
                }}
                dir="ltr"
                onClick={() => setActiveGroupId(group.id)}
              />
            ))}
          </div>
        </div>
      )}
      {contextMenu && (
        <TabContextMenu
          entry={contextMenu.entry}
          allEntries={allEntries}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onRename={renameEntry}
          onClear={clearTerminal}
          onKill={killProcess}
          onSplit={handleSplit}
          onFontSize={changeFontSize}
          onFind={() => { setFindBarEntry(contextMenu.entry); }}
          onSelectAll={() => { contextMenu.entry.term.selectAll(); }}
          onCopy={() => { navigator.clipboard.writeText(contextMenu.entry.term.getSelection()); }}
        />
      )}
    </section>
  );
}
