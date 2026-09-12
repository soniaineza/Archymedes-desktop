import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { TERMINAL_SHELL_CHOICES, TERMINAL_SHELL_LABELS } from "@shared/types";
import type { TerminalShellChoice } from "@shared/types";
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
  /** Drag handle rendered at the panel's top edge (pane resizing). */
  resizeHandle?: React.ReactNode;
}

interface TermEntry {
  ptyId: string | null;
  term: Terminal;
  fit: FitAddon;
}

export function TerminalPanel({ workspace, onFileChange, resizeHandle }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [tabIds, setTabIds] = useState<number[]>([0]);
  const [activeTab, setActiveTab] = useState(0);
  /** Shell choice per tab, made when the tab was created. */
  const [tabShells, setTabShells] = useState<Map<number, TerminalShellChoice>>(new Map());
  /** Label of the shell that actually launched, per tab (fallbacks included). */
  const [tabLabels, setTabLabels] = useState<Map<number, string>>(new Map());
  /** Tabs whose shell process has exited — shown dimmed with a dead marker. */
  const [exitedTabs, setExitedTabs] = useState<Set<number>>(new Set());
  /** The global Settings shell — shown as the "(default)" hint in the menu. */
  const [defaultShell, setDefaultShell] = useState<TerminalShellChoice>("default");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [nudge, setNudge] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef<Map<number, TermEntry>>(new Map());
  const shellsRef = useRef<Map<number, TerminalShellChoice>>(new Map());
  shellsRef.current = tabShells;
  const activeRef = useRef(activeTab);
  activeRef.current = activeTab;

  useEffect(() => {
    void window.archymedes.getSettings().then((s) => setDefaultShell(s.terminalShell ?? "default"));
  }, []);

  // Close the ＋ menu on outside clicks.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const host = e.target as HTMLElement;
      if (!host.closest(".term-add-wrap")) setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  // Create the active tab's terminal when missing, and (re)wire its listeners
  // on every pass — StrictMode double-invokes effects in dev, and a
  // create-only-once pattern would leave the second pass with no data wiring.
  useEffect(() => {
    if (collapsed) return;
    const host = hostRef.current;
    let entry = termsRef.current.get(activeTab);

    if (!entry) {
      const term = new Terminal({
        fontSize: 12.5,
        fontFamily: '"Cascadia Code", Consolas, monospace',
        theme: TERM_COLORS[getTheme()],
        cursorBlink: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      if (host) {
        term.open(host);
        try { fit.fit(); } catch { /* hidden container */ }
      }
      entry = { ptyId: null, term, fit };
      termsRef.current.set(activeTab, entry);
      setTick((t) => t + 1); // re-run the attach effect

      const shellChoice = shellsRef.current.get(activeTab);
      void window.archymedes.createTerminal(undefined, shellChoice).then((info) => {
        // The tab may have been closed before the PTY resolved.
        if (termsRef.current.get(activeTab) !== entry) return;
        entry!.ptyId = info.id;
        setTabLabels((m) => new Map(m).set(activeTab, info.shellLabel ?? "shell"));
        window.archymedes.terminalResize(info.id, term.cols, term.rows);
        if (info.warning) {
          term.write(`\r\n\x1b[33m⚠ ${info.warning}\x1b[0m\r\n\r\n`);
        }
      });
    }

    const e = entry;

    const offData = window.archymedes.onTerminalData((tid, data) => {
      if (e.ptyId && tid === e.ptyId) e.term.write(data);
    });
    const offExit = window.archymedes.onTerminalExit((tid) => {
      if (e.ptyId && tid === e.ptyId) {
        e.term.write("\r\n\x1b[90m[process exited]")
        e.term.write("\x1b[0m\r\n\r\n");
        setExitedTabs((s) => new Set(s).add(activeTab));
      }
    });
    const dataHandler = e.term.onData((data) => {
      if (e.ptyId) {
        window.archymedes.terminalWrite(e.ptyId, data);
        if (data === "\r") setTimeout(onFileChange, 800);
      }
    });

    const onResize = () => {
      const active = termsRef.current.get(activeRef.current);
      if (!active) return;
      try {
        active.fit.fit();
        if (active.ptyId) window.archymedes.terminalResize(active.ptyId, active.term.cols, active.term.rows);
      } catch {
        // container may be hidden mid-layout; harmless
      }
    };
    window.addEventListener("resize", onResize);
    const ro = host ? new ResizeObserver(onResize) : null;
    if (host) ro!.observe(host);
    const onFocusRequest = () => {
      if (activeRef.current === activeTab) e.term.focus();
    };
    document.addEventListener("focus-terminal", onFocusRequest);

    // Follow live theme changes.
    const onTheme = (ev: Event) => {
      const id = (ev as CustomEvent<Theme>).detail;
      const colors = TERM_COLORS[id];
      if (colors) e.term.options.theme = colors;
    };
    window.addEventListener("archymedes-theme", onTheme);

    return () => {
      offData();
      offExit();
      dataHandler.dispose();
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      document.removeEventListener("focus-terminal", onFocusRequest);
      window.removeEventListener("archymedes-theme", onTheme);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, activeTab, workspace, nudge]);

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
    // Kill the PTY process, not just the view — otherwise the shell keeps
    // running invisibly for the rest of the app's lifetime.
    if (entry?.ptyId) window.archymedes.killTerminal(entry.ptyId);
    entry?.term.dispose();
    termsRef.current.delete(tabId);
    setTabShells((m) => {
      const next = new Map(m);
      next.delete(tabId);
      return next;
    });
    setTabLabels((m) => {
      const next = new Map(m);
      next.delete(tabId);
      return next;
    });
    const next = tabIds.filter((t) => t !== tabId);
    if (next.length === 0) {
      setTabIds([0]);
      setActiveTab(0);
    } else {
      setTabIds(next);
      if (activeTab === tabId) setActiveTab(next[next.length - 1]);
    }
  };

  const addTab = (choice: TerminalShellChoice) => {
    const newId = Math.max(...tabIds) + 1;
    setTabShells((m) => new Map(m).set(newId, choice));
    setTabIds((ids) => [...ids, newId]);
    setActiveTab(newId);
    setAddMenuOpen(false);
  };

  /** Respawn a dead tab's shell in place: fresh PTY, fresh scrollback. */
  const respawnTab = (tabId: number) => {
    setExitedTabs((s) => {
      const next = new Set(s);
      next.delete(tabId);
      return next;
    });
    // Dispose the dead view and drop its entry so the create-effect builds a
    // fresh one; shell choice falls back to the global default.
    const entry = termsRef.current.get(tabId);
    entry?.term.dispose();
    termsRef.current.delete(tabId);
    setTabShells((m) => {
      const next = new Map(m);
      next.delete(tabId);
      return next;
    });
    setTabLabels((m) => {
      const next = new Map(m);
      next.delete(tabId);
      return next;
    });
    setActiveTab(tabId); // make it the target of the next effect pass
    setNudge((n) => n + 1); // force the create-effect to run
  };

  /** Prefer the label of the shell that actually launched (fallbacks included). */
  const shellBadge = (tabId: number): string => {
    const launched = tabLabels.get(tabId);
    if (launched) return launched;
    const choice = tabShells.get(tabId);
    if (choice && choice !== "default") return TERMINAL_SHELL_LABELS[choice];
    return TERMINAL_SHELL_LABELS[defaultShell];
  };

  return (
    <div className={`terminal-panel${collapsed ? " collapsed" : ""}`}>
      {!collapsed && resizeHandle}
      <div className="terminal-chrome">
        <div className="terminal-tabs">
          <span className="term-label" onClick={() => setCollapsed((c) => !c)}>
            <span className="toggle">{collapsed ? "▲" : "▼"}</span> terminal
          </span>
          {!collapsed &&
            tabIds.map((tabId) => (
              <span
                key={tabId}
                className={`term-tab${tabId === activeTab ? " active" : ""}${exitedTabs.has(tabId) ? " exited" : ""}`}
                onClick={() => setActiveTab(tabId)}
                onDoubleClick={() => { if (exitedTabs.has(tabId)) respawnTab(tabId); }}
                title={exitedTabs.has(tabId) ? "Shell exited — double-click to respawn" : undefined}
              >
                {exitedTabs.has(tabId) ? "☠ " : ""}{shellBadge(tabId)} {tabId + 1}
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
            <span className="term-add-wrap">
              <button
                className="term-add"
                title="New terminal — pick a shell"
                onClick={() => setAddMenuOpen((o) => !o)}
              >
                ＋ ▾
              </button>
              {addMenuOpen && (
                <div className="term-shell-menu">
                  {TERMINAL_SHELL_CHOICES.map((id) => (
                    <button key={id} className="term-shell-item" onClick={() => addTab(id)}>
                      <span>{TERMINAL_SHELL_LABELS[id]}</span>
                      {id === "default" && (
                        <span className="hint">{TERMINAL_SHELL_LABELS[defaultShell]}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
        </div>
      </div>
      {!collapsed && <div className="terminal-body" ref={hostRef} />}
    </div>
  );
}
