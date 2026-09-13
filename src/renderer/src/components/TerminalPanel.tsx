import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { getTheme, resolveTheme } from "../lib/theme";
import type { ResolvedTheme } from "../lib/theme";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

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
  dispose: () => void;
}

export function TerminalPanel({ workspace, collapsed, height, onToggleCollapsed, onFileChange }: Props) {
  const { t, formatNumber } = useI18n();
  const [tabIds, setTabIds] = useState<number[]>([0]);
  const [activeTab, setActiveTab] = useState(0);
  const [tick, setTick] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Map<number, TermEntry>>(new Map());
  const activeRef = useRef(activeTab);
  const tRef = useRef(t);
  activeRef.current = activeTab;
  tRef.current = t;

  // Create a terminal for the active tab when it has none yet.
  useEffect(() => {
    if (collapsed || termsRef.current.has(activeTab)) return;

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

    const entry: TermEntry = { ptyId: null, term, fit, dispose: () => term.dispose() };
    termsRef.current.set(activeTab, entry);
    setTick((n) => n + 1);

    let disposed = false;
    void window.archymedes.createTerminal().then((info) => {
      if (disposed) return;
      entry.ptyId = info.id;
      window.archymedes.terminalResize(info.id, term.cols, term.rows);
    });

    const offData = window.archymedes.onTerminalData((id, data) => {
      if (entry.ptyId && id === entry.ptyId) term.write(data);
    });
    const offExit = window.archymedes.onTerminalExit((id) => {
      if (entry.ptyId && id === entry.ptyId) term.write(`\r\n\x1b[90m${tRef.current("terminal.exited")}\x1b[0m\r\n`);
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
  }, [collapsed, activeTab, workspace]);

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
    termsRef.current.get(tabId)?.dispose();
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

  const addTab = () => {
    const newId = Math.max(...tabIds) + 1;
    setTabIds((ids) => [...ids, newId]);
    setActiveTab(newId);
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
            {tabIds.map((tabId) => (
              <div
                key={tabId}
                role="tab"
                aria-selected={tabId === activeTab}
                tabIndex={tabId === activeTab ? 0 : -1}
                className={`term-tab${tabId === activeTab ? " active" : ""}`}
                onClick={() => setActiveTab(tabId)}
              >
                {t("terminal.shell", { n: formatNumber(tabId + 1) })}
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
            ))}
            <button className="icon-btn" onClick={addTab} title={t("terminal.new")} aria-label={t("terminal.new")}>
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}
      </div>
      {!collapsed && <div className="terminal-body" ref={hostRef} dir="ltr" />}
    </section>
  );
}
