import { useEffect, useRef, useState, useCallback } from "react";
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

// ─── Colors ───────────────────────────────────────────────────────────────

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

// ─── Shell menu ───────────────────────────────────────────────────────────

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

// ─── Per-tab entry stored in a ref ────────────────────────────────────────

interface TermEntry {
  tabId: number;
  ptyId: string | null;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  exited: boolean;
  shellChoice: TerminalShellChoice;
  shellLabel: string | null;
  fontSize: number;
  dispose: () => void;
}

// ─── Find bar ─────────────────────────────────────────────────────────────

function FindBar({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
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
      if (!q) { search.clearDecorations(); setMatchInfo({ current: 0, total: 0 }); return; }
      search.findNext(q);
    },
    [search],
  );

  return (
    <div className="term-find-bar">
      <input
        ref={inputRef}
        className="input mono term-find-input"
        placeholder={t("terminal.findPlaceholder")}
        value={query}
        onChange={(e) => doSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter") { if (e.shiftKey) search.findPrevious(query); else search.findNext(query); }
        }}
      />
      <span className="term-find-count">
        {query && matchInfo.total > 0
          ? t("terminal.findMatchCount", { current: matchInfo.current + 1, total: matchInfo.total })
          : query ? t("terminal.findNoMatch") : ""}
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

// ─── Context menu ─────────────────────────────────────────────────────────

function TabContextMenu({
  entry, position, onClose, onRename, onClear, onKill, onSplit, onFontSize, onFind, onSelectAll, onCopy,
}: {
  entry: TermEntry;
  position: { x: number; y: number };
  onClose: () => void;
  onRename: (id: number, title: string) => void;
  onClear: (id: number) => void;
  onKill: (id: number) => void;
  onSplit: (id: number, dir: "right" | "down") => void;
  onFontSize: (id: number, delta: number) => void;
  onFind: () => void;
  onSelectAll: () => void;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  return (
    <div ref={menuRef} className="term-context-menu popover" style={{ position: "fixed", left: position.x, top: position.y, zIndex: 100 }}>
      <button onClick={() => { onFind(); onClose(); }}><Icon name="search" size={13} />{t("terminal.find")}</button>
      <button onClick={() => { onSelectAll(); onClose(); }}><Icon name="file" size={13} />{t("terminal.selectText")}</button>
      <button onClick={() => { onCopy(); onClose(); }}><Icon name="copy" size={13} />{t("terminal.copySelection")}</button>
      <div className="ctx-separator" />
      <button onClick={() => { const name = prompt(t("terminal.rename"), entry.shellLabel ?? ""); if (name !== null) onRename(entry.tabId, name); onClose(); }}>
        <Icon name="pencil" size={13} />{t("terminal.rename")}
      </button>
      <button onClick={() => { onClear(entry.tabId); onClose(); }}><Icon name="x" size={13} />{t("terminal.clear")}</button>
      <div className="ctx-separator" />
      <button onClick={() => { onSplit(entry.tabId, "right"); onClose(); }}><Icon name="splitV" size={13} />{t("terminal.splitRight")}</button>
      <button onClick={() => { onSplit(entry.tabId, "down"); onClose(); }}><Icon name="splitH" size={13} />{t("terminal.splitDown")}</button>
      <div className="ctx-separator" />
      <button onClick={() => { onFontSize(entry.tabId, 1); onClose(); }}><Icon name="plus" size={13} />{t("terminal.fontSizeUp")}</button>
      <button onClick={() => { onFontSize(entry.tabId, -1); onClose(); }}><Icon name="minus" size={13} />{t("terminal.fontSizeDown")}</button>
      <button onClick={() => { onFontSize(entry.tabId, 0); onClose(); }}><Icon name="refresh" size={13} />{t("terminal.fontSizeReset")}</button>
      <div className="ctx-separator" />
      <button className="danger" onClick={() => { onKill(entry.tabId); onClose(); }}><Icon name="stop" size={13} />{t("terminal.killProcess")}</button>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────

export function TerminalPanel({ workspace, collapsed, height, onToggleCollapsed, onFileChange }: {
  workspace: string;
  collapsed: boolean;
  height: number;
  onToggleCollapsed: () => void;
  onFileChange: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const [tabIds, setTabIds] = useState<number[]>([0]);
  const [activeTab, setActiveTab] = useState(0);
  const [tick, setTick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [findBarEntry, setFindBarEntry] = useState<TermEntry | null>(null);
  const [contextMenu, setContextMenu] = useState<{ entry: TermEntry; x: number; y: number } | null>(null);
  const [tabTitles, setTabTitles] = useState<Record<number, string>>({});

  const menuRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Map<number, TermEntry>>(new Map());
  const pendingChoiceRef = useRef<Map<number, TerminalShellChoice>>(new Map());
  const activeRef = useRef(activeTab);
  const tRef = useRef(t);
  activeRef.current = activeTab;
  tRef.current = t;

  // ── Close shell menu on outside click ──
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  // ── Close context menu on outside click ──
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [contextMenu]);

  // ── Create a terminal for the active tab ──
  useEffect(() => {
    if (collapsed || termsRef.current.has(activeTab)) return;
    const shellChoice = pendingChoiceRef.current.get(activeTab) ?? "default";

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

    term.onBell(() => {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Archymedes", { body: t("terminal.bell"), silent: true });
      }
    });

    const host = hostRef.current;
    if (host) {
      host.innerHTML = "";
      term.open(host);
      fit.fit();
    }

    const entry: TermEntry = {
      tabId: activeTab,
      ptyId: null,
      term,
      fit,
      search,
      exited: false,
      shellChoice,
      shellLabel: null,
      fontSize: DEFAULT_FONT_SIZE,
      dispose: () => term.dispose(),
    };
    termsRef.current.set(activeTab, entry);
    setTick((n) => n + 1);

    let disposed = false;
    void window.archymedes.createTerminal(undefined, shellChoice).then((info) => {
      if (disposed) return;
      entry.ptyId = info.id;
      entry.shellLabel = info.shellLabel ?? null;
      if (info.warning) term.write(`\x1b[33m⚠ ${info.warning}\x1b[0m\r\n`);
      window.archymedes.terminalResize(info.id, term.cols, term.rows);
      setTick((n) => n + 1);
    });

    const offData = window.archymedes.onTerminalData((id, data) => {
      if (entry.ptyId && id === entry.ptyId) term.write(data);
    });
    const offExit = window.archymedes.onTerminalExit((id) => {
      if (entry.ptyId && id === entry.ptyId) {
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

    entry.dispose = () => {
      disposed = true;
      offData();
      offExit();
      dataHandler.dispose();
      term.dispose();
    };

    const onResize = () => {
      const current = termsRef.current.get(activeRef.current);
      if (!current) return;
      try {
        current.fit.fit();
        if (current.ptyId) window.archymedes.terminalResize(current.ptyId, current.term.cols, current.term.rows);
      } catch { /* hidden */ }
    };
    window.addEventListener("resize", onResize);
    const observer = host ? new ResizeObserver(onResize) : null;
    if (host) observer?.observe(host);

    const onFocusRequest = () => {
      if (activeRef.current === activeTab) term.focus();
    };
    document.addEventListener("focus-terminal", onFocusRequest);

    const onTheme = (e: Event) => {
      const colors = TERM_COLORS[(e as CustomEvent<ResolvedTheme>).detail];
      if (colors) term.options.theme = colors;
    };
    window.addEventListener("archymedes-theme", onTheme);

    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      document.removeEventListener("focus-terminal", onFocusRequest);
      window.removeEventListener("archymedes-theme", onTheme);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, activeTab, workspace, tick]);

  // ── Attach active terminal DOM when switching tabs or expanding ──
  useEffect(() => {
    if (collapsed) return;
    const host = hostRef.current;
    const entry = termsRef.current.get(activeTab);
    if (host && entry && entry.term.element?.parentElement !== host) {
      host.innerHTML = "";
      if (entry.term.element) host.appendChild(entry.term.element);
      try { entry.fit.fit(); } catch { /* hidden */ }
      entry.term.focus();
    }
  }, [activeTab, collapsed, tick]);

  // ── Cleanup all on unmount ──
  useEffect(() => {
    return () => {
      for (const entry of termsRef.current.values()) entry.dispose();
      termsRef.current.clear();
    };
  }, []);

  // ── Global font-size shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); changeFontSizeAll(1); }
      else if (e.key === "-") { e.preventDefault(); changeFontSizeAll(-1); }
      else if (e.key === "0") { e.preventDefault(); changeFontSizeAll(0); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Actions ──

  const changeFontSizeAll = (delta: number) => {
    for (const entry of termsRef.current.values()) {
      const sz = delta === 0 ? DEFAULT_FONT_SIZE : Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, entry.fontSize + delta));
      entry.fontSize = sz;
      entry.term.options.fontSize = sz;
      try { entry.fit.fit(); } catch { /* hidden */ }
    }
    setTick((n) => n + 1);
  };

  const changeFontSize = (tabId: number, delta: number) => {
    const entry = termsRef.current.get(tabId);
    if (!entry) return;
    const sz = delta === 0 ? DEFAULT_FONT_SIZE : Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, entry.fontSize + delta));
    entry.fontSize = sz;
    entry.term.options.fontSize = sz;
    try { entry.fit.fit(); } catch { /* hidden */ }
    setTick((n) => n + 1);
  };

  const closeTab = (tabId: number) => {
    const entry = termsRef.current.get(tabId);
    if (entry?.ptyId) window.archymedes.terminalKill(entry.ptyId);
    entry?.dispose();
    termsRef.current.delete(tabId);
    const next = tabIds.filter((id) => id !== tabId);
    if (next.length === 0) {
      setTabIds([0]);
      setActiveTab(0);
    } else {
      setTabIds(next);
      if (activeTab === tabId) setActiveTab(next[next.length - 1]);
    }
  };

  const addTabWithChoice = (choice: TerminalShellChoice) => {
    const newId = Math.max(...tabIds, 0) + 1;
    pendingChoiceRef.current.set(newId, choice);
    setTabIds((ids) => [...ids, newId]);
    setActiveTab(newId);
    setMenuOpen(false);
  };

  const respawnTab = (tabId: number) => {
    const entry = termsRef.current.get(tabId);
    if (!entry?.exited) return;
    entry.dispose();
    termsRef.current.delete(tabId);
    pendingChoiceRef.current.set(tabId, entry.shellChoice);
    setTick((n) => n + 1);
  };

  const handleSplit = (tabId: number, _dir: "right" | "down") => {
    const entry = termsRef.current.get(tabId);
    if (!entry) return;
    addTabWithChoice(entry.shellChoice);
  };

  // ── Render ──

  const getTabLabel = (entry: TermEntry | undefined) => {
    if (!entry) return "";
    const custom = tabTitles[entry.tabId];
    if (custom) return custom;
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
            {tabIds.map((tabId) => {
              const entry = termsRef.current.get(tabId);
              return (
                <div
                  key={tabId}
                  role="tab"
                  aria-selected={tabId === activeTab}
                  tabIndex={tabId === activeTab ? 0 : -1}
                  className={`term-tab${tabId === activeTab ? " active" : ""}${entry?.exited ? " exited" : ""}`}
                  onClick={() => setActiveTab(tabId)}
                  onDoubleClick={() => { if (entry?.exited) respawnTab(tabId); }}
                  onContextMenu={(e) => { e.preventDefault(); if (entry) setContextMenu({ entry, x: e.clientX, y: e.clientY }); }}
                  title={entry?.exited ? t("terminal.respawnHint") : undefined}
                >
                  <span className="term-tab-label">
                    {t("terminal.shell", { n: formatNumber(tabId + 1) })}
                    <span className="term-shell-badge">{getTabLabel(entry)}</span>
                    {entry?.exited && <span className="term-exited-dot" />}
                  </span>
                  {tabIds.length > 1 && (
                    <button
                      className="tab-close"
                      onClick={(e) => { e.stopPropagation(); closeTab(tabId); }}
                      aria-label={t("terminal.close")}
                      title={t("terminal.close")}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </div>
              );
            })}
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
                    <button key={item.choice} role="menuitem" onClick={() => addTabWithChoice(item.choice)}>
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
          {findBarEntry && <FindBar search={findBarEntry.search} onClose={() => setFindBarEntry(null)} />}
          <div className="terminal-body" ref={hostRef} dir="ltr" />
        </div>
      )}
      {contextMenu && (
        <TabContextMenu
          entry={contextMenu.entry}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onRename={(id, title) => { setTabTitles((prev) => ({ ...prev, [id]: title })); setTick((n) => n + 1); }}
          onClear={(id) => { const e = termsRef.current.get(id); if (e) e.term.clear(); }}
          onKill={(id) => { const e = termsRef.current.get(id); if (e?.ptyId) window.archymedes.terminalKill(e.ptyId); }}
          onSplit={handleSplit}
          onFontSize={changeFontSize}
          onFind={() => setFindBarEntry(contextMenu.entry)}
          onSelectAll={() => contextMenu.entry.term.selectAll()}
          onCopy={() => { navigator.clipboard.writeText(contextMenu.entry.term.getSelection() ?? ""); }}
        />
      )}
    </section>
  );
}
