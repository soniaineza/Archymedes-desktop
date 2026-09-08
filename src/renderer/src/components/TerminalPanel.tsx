import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { getTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";

interface XtermColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

/** Terminal palettes per app theme. */
const TERM_COLORS: Record<Theme, XtermColors> = {
  dark: { background: "#0a0a0a", foreground: "#e8e8e8", cursor: "#ffffff", selectionBackground: "#3a3a3a" },
  light: { background: "#ffffff", foreground: "#1a1a1a", cursor: "#1a1a1a", selectionBackground: "#c4c4c4" },
  "solarized-dark": { background: "#002b36", foreground: "#dcdccc", cursor: "#fdf6e3", selectionBackground: "#1c5a6a" },
  "solarized-light": { background: "#fdf6e3", foreground: "#073642", cursor: "#002b36", selectionBackground: "#c9c0a5" },
  "high-contrast": { background: "#000000", foreground: "#ffffff", cursor: "#ffffff", selectionBackground: "#888888" },
};

interface Props {
  workspace: string;
  onFileChange: () => void;
}

interface TermEntry {
  ptyId: string | null;
  term: Terminal;
  fit: FitAddon;
  dispose: () => void;
}

export function TerminalPanel({ workspace, onFileChange }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [tabIds, setTabIds] = useState<number[]>([0]);
  const [activeTab, setActiveTab] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Map<number, TermEntry>>(new Map());
  const activeRef = useRef(activeTab);
  activeRef.current = activeTab;

  // Create a terminal entry for the active tab when missing.
  useEffect(() => {
    if (collapsed) return;
    if (termsRef.current.has(activeTab)) return;

    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      theme: TERM_COLORS[getTheme()],
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const host = hostRef.current;
    if (host) {
      host.innerHTML = "";
      term.open(host);
      fit.fit();
    }

    const entry: TermEntry = {
      ptyId: null,
      term,
      fit,
      dispose: () => {
        term.dispose();
      },
    };
    termsRef.current.set(activeTab, entry);
    setTick((t) => t + 1); // re-run the attach effect

    let disposed = false;

    void window.archymedes.createTerminal().then((info) => {
      if (disposed) return;
      entry.ptyId = info.id;
      window.archymedes.terminalResize(info.id, term.cols, term.rows);
    });

    const offData = window.archymedes.onTerminalData((tid, data) => {
      if (entry.ptyId && tid === entry.ptyId) term.write(data);
    });
    const offExit = window.archymedes.onTerminalExit((tid) => {
      if (entry.ptyId && tid === entry.ptyId) {
        term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
      }
    });
    const dataHandler = term.onData((data) => {
      if (entry.ptyId) {
        window.archymedes.terminalWrite(entry.ptyId, data);
        if (data === "\r") setTimeout(onFileChange, 800);
      }
    });

    entry.dispose = () => {
      disposed = true;
      offData();
      offExit();
      dataHandler.dispose();
      term.dispose();
    };

    const onResize = () => {
      const e = termsRef.current.get(activeRef.current);
      if (!e) return;
      try {
        e.fit.fit();
        if (e.ptyId) window.archymedes.terminalResize(e.ptyId, e.term.cols, e.term.rows);
      } catch {
        // container may be hidden mid-layout; harmless
      }
    };
    window.addEventListener("resize", onResize);
    const ro = host ? new ResizeObserver(onResize) : null;
    if (host) ro!.observe(host);
    const onFocusRequest = () => {
      if (activeRef.current === activeTab) term.focus();
    };
    document.addEventListener("focus-terminal", onFocusRequest);

    // Follow live theme changes.
    const onTheme = (e: Event) => {
      const id = (e as CustomEvent<Theme>).detail;
      const colors = TERM_COLORS[id];
      if (colors) term.options.theme = colors;
    };
    window.addEventListener("archymedes-theme", onTheme);

    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      document.removeEventListener("focus-terminal", onFocusRequest);
      window.removeEventListener("archymedes-theme", onTheme);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, activeTab, workspace]);

  const [tick, setTick] = useState(0);

  // Attach the active terminal's DOM when switching tabs.
  useEffect(() => {
    if (collapsed) return;
    const host = hostRef.current;
    const entry = termsRef.current.get(activeTab);
    if (host && entry && entry.term.element?.parentElement !== host) {
      host.innerHTML = "";
      if (entry.term.element) host.appendChild(entry.term.element);
      try { entry.fit.fit(); } catch { /* hidden container */ }
      entry.term.focus();
    }
  }, [activeTab, collapsed, tick]);

  const closeTab = (tabId: number) => {
    const entry = termsRef.current.get(tabId);
    entry?.dispose();
    termsRef.current.delete(tabId);
    const next = tabIds.filter((t) => t !== tabId);
    if (next.length === 0) {
      setTabIds([0]);
      setActiveTab(0);
    } else {
      setTabIds(next);
      if (activeTab === tabId) setActiveTab(next[next.length - 1]);
    }
  };

  return (
    <div className={`terminal-panel${collapsed ? " collapsed" : ""}`}>
      <div className="terminal-chrome">
        <div className="terminal-tabs">
          <span className="term-label" onClick={() => setCollapsed((c) => !c)}>
            <span className="toggle">{collapsed ? "▲" : "▼"}</span> terminal
          </span>
          {!collapsed &&
            tabIds.map((tabId) => (
              <span
                key={tabId}
                className={`term-tab${tabId === activeTab ? " active" : ""}`}
                onClick={() => setActiveTab(tabId)}
              >
                shell {tabId + 1}
                {tabIds.length > 1 && (
                  <button
                    className="term-close"
                    onClick={(e) => { e.stopPropagation(); closeTab(tabId); }}
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
          {!collapsed && (
            <button
              className="term-add"
              title="New terminal"
              onClick={() => {
                const newId = Math.max(...tabIds) + 1;
                setTabIds((ids) => [...ids, newId]);
                setActiveTab(newId);
              }}
            >
              ＋
            </button>
          )}
        </div>
      </div>
      {!collapsed && <div className="terminal-body" ref={hostRef} />}
    </div>
  );
}
