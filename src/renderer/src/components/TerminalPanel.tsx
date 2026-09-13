import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { getTheme, resolveTheme } from "../lib/theme";
import type { ResolvedTheme } from "../lib/theme";
import type { TerminalShellChoice } from "@shared/types";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";

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

/** The per-tab shell menu; "default" reads the saved Settings value. */
const SHELL_MENU: { choice: TerminalShellChoice; icon: IconName; labelKey: MessageKey }[] = [
  { choice: "default", icon: "terminal", labelKey: "terminal.shellDefault" },
  { choice: "powershell", icon: "terminal", labelKey: "terminal.shellPowershell" },
  { choice: "cmd", icon: "terminal", labelKey: "terminal.shellCmd" },
  { choice: "gitbash", icon: "terminal", labelKey: "terminal.shellGitBash" },
  { choice: "custom", icon: "sliders", labelKey: "terminal.shellCustom" },
];

interface Props {
  workspace: string;
  collapsed: boolean;
  height: number;
  onToggleCollapsed: () => void;
  onFileChange: () => void;
}

interface TermEntry {
  ptyId: string | null;
  term: Terminal;
  fit: FitAddon;
  exited: boolean;
  shellChoice: TerminalShellChoice;
  shellLabel: string | null;
  dispose: () => void;
}

export function TerminalPanel({ workspace, collapsed, height, onToggleCollapsed, onFileChange }: Props) {
  const { t, formatNumber } = useI18n();
  const [tabIds, setTabIds] = useState<number[]>([0]);
  const [activeTab, setActiveTab] = useState(0);
  const [tick, setTick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Map<number, TermEntry>>(new Map());
  /** Shell choices waiting for their tab's create effect to run. */
  const pendingChoiceRef = useRef<Map<number, TerminalShellChoice>>(new Map());
  const activeRef = useRef(activeTab);
  const tRef = useRef(t);
  activeRef.current = activeTab;
  tRef.current = t;

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

  // Create a terminal for the active tab when it has none yet. `tick` is a
  // dependency so respawn can dispose an entry and re-trigger creation.
  useEffect(() => {
    if (collapsed || termsRef.current.has(activeTab)) return;
    const shellChoice = pendingChoiceRef.current.get(activeTab) ?? "default";

    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: '"Cascadia Code", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      theme: TERM_COLORS[resolveTheme(getTheme())],
      cursorBlink: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const host = hostRef.current;
    if (host) {
      host.innerHTML = "";
      term.open(host);
      fit.fit();
    }

    const entry: TermEntry = { ptyId: null, term, fit, exited: false, shellChoice, shellLabel: null, dispose: () => term.dispose() };
    termsRef.current.set(activeTab, entry);
    setTick((n) => n + 1);

    let disposed = false;
    void window.archymedes.createTerminal(undefined, shellChoice).then((info) => {
      if (disposed) return;
      entry.ptyId = info.id;
      entry.shellLabel = info.shellLabel ?? null;
      if (info.warning) term.write(`\x1b[33m⚠ ${info.warning}\x1b[0m\r\n`);
      window.archymedes.terminalResize(info.id, term.cols, term.rows);
      setTick((n) => n + 1); // re-render so the tab badge shows the launched shell
    });

    const offData = window.archymedes.onTerminalData((id, data) => {
      if (entry.ptyId && id === entry.ptyId) term.write(data);
    });
    const offExit = window.archymedes.onTerminalExit((id) => {
      if (entry.ptyId && id === entry.ptyId) {
        entry.exited = true;
        term.write(`\r\n\x1b[90m${tRef.current("terminal.exited")}\x1b[0m\r\n`);
        setTick((n) => n + 1); // dim the dead tab
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
      } catch {
        // container may be hidden mid-layout; harmless
      }
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

  // Attach the active terminal's DOM when switching tabs or expanding.
  useEffect(() => {
    if (collapsed) return;
    const host = hostRef.current;
    const entry = termsRef.current.get(activeTab);
    if (host && entry && entry.term.element?.parentElement !== host) {
      host.innerHTML = "";
      if (entry.term.element) host.appendChild(entry.term.element);
      try {
        entry.fit.fit();
      } catch {
        // hidden container
      }
      entry.term.focus();
    }
  }, [activeTab, collapsed, tick]);

  useEffect(() => {
    const terms = termsRef.current;
    return () => {
      for (const entry of terms.values()) entry.dispose();
      terms.clear();
    };
  }, []);

  const closeTab = (tabId: number) => {
    const entry = termsRef.current.get(tabId);
    if (entry?.ptyId) window.archymedes.terminalKill(entry.ptyId); // kill the shell, not just the view
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
    const newId = Math.max(...tabIds) + 1;
    pendingChoiceRef.current.set(newId, choice);
    setTabIds((ids) => [...ids, newId]);
    setActiveTab(newId);
    setMenuOpen(false);
  };

  /** Dispose the dead entry and recreate the tab with the same shell. */
  const respawnTab = (tabId: number) => {
    const entry = termsRef.current.get(tabId);
    if (!entry?.exited) return;
    entry.dispose();
    termsRef.current.delete(tabId);
    pendingChoiceRef.current.set(tabId, entry.shellChoice);
    setTick((n) => n + 1); // re-runs the create effect for the active tab
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
              const fallbackKey = SHELL_MENU.find((m) => m.choice === entry?.shellChoice)?.labelKey ?? "terminal.shellDefault";
              const label = entry?.shellLabel ?? t(fallbackKey);
              return (
                <div
                  key={tabId}
                  role="tab"
                  aria-selected={tabId === activeTab}
                  tabIndex={tabId === activeTab ? 0 : -1}
                  className={`term-tab${tabId === activeTab ? " active" : ""}${entry?.exited ? " exited" : ""}`}
                  onClick={() => setActiveTab(tabId)}
                  onDoubleClick={() => {
                    if (entry?.exited) void respawnTab(tabId);
                  }}
                  title={entry?.exited ? t("terminal.respawnHint") : undefined}
                >
                  <span className="term-tab-label">
                    {t("terminal.shell", { n: formatNumber(tabId + 1) })}
                    {label && <span className="term-shell-badge">{label}</span>}
                  </span>
                  {tabIds.length > 1 && (
                    <button
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tabId);
                      }}
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
      {!collapsed && <div className="terminal-body" ref={hostRef} dir="ltr" />}
    </section>
  );
}
