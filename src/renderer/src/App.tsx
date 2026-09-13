import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileNode, ProviderSettings } from "@shared/types";
import { formatModelLabel, PROVIDER_INFO } from "@shared/providers";
import { AgentPanel } from "./components/AgentPanel";
import { CodeEditor } from "./components/CodeEditor";
import { CommandPalette } from "./components/CommandPalette";
import type { Command } from "./components/CommandPalette";
import { DiffModal } from "./components/DiffModal";
import { Icon } from "./components/Icon";
import { LanguageSelect } from "./components/LanguageSelect";
import { QuickOpen } from "./components/QuickOpen";
import { SearchPanel } from "./components/SearchPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { StatusBar, useGitStatus } from "./components/StatusBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { useToast } from "./components/Toasts";
import { Welcome } from "./components/Welcome";
import { useI18n } from "./i18n/I18nProvider";
import { LOCALES } from "./i18n/locales";
import { flattenFiles } from "./lib/files";
import { pushRecent } from "./lib/recent";
import type { OpenTab } from "./lib/tabs";
import { applyTheme, cycleTheme, getTheme, themeIcon, THEMES, watchSystemTheme } from "./lib/theme";
import type { Theme } from "./lib/theme";
import { useAgent } from "./lib/useAgent";
import { useResizable } from "./lib/useResizable";

type Overlay = "settings" | "palette" | "quickOpen" | "search" | null;

function readStored<T>(key: string, parse: (raw: string) => T | undefined, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // layout preferences are best-effort
  }
}

const parseBool = (raw: string) => (raw === "true" ? true : raw === "false" ? false : undefined);
const parseScale = (raw: string) => {
  const value = Number(raw);
  return value >= 0.5 && value <= 2 ? value : undefined;
};

export default function App() {
  const { t, shortcut, setPreference } = useI18n();
  const notify = useToast();

  const [workspace, setWorkspace] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [modelLabel, setModelLabel] = useState("");
  const [editTick, setEditTick] = useState(0);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [scale, setScale] = useState(() => readStored("archymedes.scale", parseScale, 1));
  const [sidebarOpen, setSidebarOpen] = useState(() => readStored("archymedes.sidebar-open", parseBool, true));
  const [agentOpen, setAgentOpen] = useState(() => readStored("archymedes.agent-open", parseBool, true));
  const [terminalCollapsed, setTerminalCollapsed] = useState(() =>
    readStored("archymedes.terminal-collapsed", parseBool, false),
  );

  const sidebar = useResizable({ storageKey: "archymedes.size.sidebar", initial: 252, min: 180, max: 520, dock: "start" });
  const agentPane = useResizable({ storageKey: "archymedes.size.agent", initial: 430, min: 320, max: 820, dock: "end" });
  const terminal = useResizable({ storageKey: "archymedes.size.terminal", initial: 240, min: 110, max: 720, dock: "bottom" });
  const resizing = sidebar.dragging || agentPane.dragging || terminal.dragging;

  const agent = useAgent({
    onRunFinished: () => {
      if (!document.hasFocus() && "Notification" in window) {
        new Notification("Archymedes", { body: t("agent.finished") });
      }
    },
  });
  const git = useGitStatus(workspace);
  const tabsRef = useRef<OpenTab[]>([]);
  tabsRef.current = tabs;

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => watchSystemTheme(), []);

  useEffect(() => {
    window.archymedes.setZoomFactor(scale);
    writeStored("archymedes.scale", String(scale));
  }, [scale]);

  useEffect(() => writeStored("archymedes.sidebar-open", String(sidebarOpen)), [sidebarOpen]);
  useEffect(() => writeStored("archymedes.agent-open", String(agentOpen)), [agentOpen]);
  useEffect(() => writeStored("archymedes.terminal-collapsed", String(terminalCollapsed)), [terminalCollapsed]);

  const applySettingsSummary = useCallback((s: ProviderSettings) => {
    setHasKey(Boolean(s.apiKey) || PROVIDER_INFO[s.provider]?.requiresApiKey === false);
    setModelLabel(formatModelLabel(s));
  }, []);

  useEffect(() => {
    void window.archymedes.getWorkspace().then(setWorkspace);
    void window.archymedes.getSettings().then(applySettingsSummary);
  }, [applySettingsSummary]);

  const refreshTree = useCallback(async () => {
    if (!workspace) return;
    try {
      setTree(await window.archymedes.listDirTree(""));
    } catch {
      setTree([]);
    }
  }, [workspace]);

  useEffect(() => {
    void refreshTree();
    if (workspace) void window.archymedes.startWatching();
    return () => {
      void window.archymedes.stopWatching();
    };
  }, [refreshTree, workspace]);

  const reloadCleanTab = useCallback((path: string, force = false) => {
    void window.archymedes
      .readFile(path)
      .then((entry) => {
        setTabs((current) =>
          current.map((tab) =>
            tab.path === path && (force || tab.content === tab.original)
              ? { ...tab, content: entry.content, original: entry.content, truncated: entry.truncated }
              : tab,
          ),
        );
      })
      .catch(() => {
        // file may have been deleted; leave the tab as it is
      });
  }, []);

  // Watcher events: refresh the tree, reload unmodified tabs, refresh the edits list.
  useEffect(() => {
    return window.archymedes.onWatchEvent(() => {
      void refreshTree();
      setEditTick((n) => n + 1);
      for (const tab of tabsRef.current) {
        if (tab.content === tab.original) reloadCleanTab(tab.path);
      }
    });
  }, [refreshTree, reloadCleanTab]);

  const enterWorkspace = (path: string) => {
    pushRecent(path);
    setWorkspace(path);
    setTabs([]);
    setActiveTab(null);
    agent.reset();
  };

  const pickWorkspace = async () => {
    const path = await window.archymedes.pickWorkspace(t("welcome.openWorkspace").replace(/…$/, ""));
    if (path) enterWorkspace(path);
  };

  const openPath = async (path: string) => {
    try {
      await window.archymedes.setWorkspace(path);
      enterWorkspace(path);
    } catch (err) {
      notify(t("editor.openFailed", { path, error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  const openFile = async (path: string, line?: number) => {
    setActiveLine(line ?? null);
    if (tabsRef.current.some((tab) => tab.path === path)) {
      setActiveTab(path);
      return;
    }
    try {
      const entry = await window.archymedes.readFile(path);
      setTabs((ts) => (ts.some((tab) => tab.path === path) ? ts : [...ts, { path, content: entry.content, original: entry.content, truncated: entry.truncated }]));
      setActiveTab(path);
    } catch (err) {
      notify(t("editor.openFailed", { path, error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  // Ctrl+1…8 activate the nth tab, Ctrl+9 the last — the Chrome/VS Code convention.
  const activateTabIndex = (index: number) => {
    const list = tabsRef.current;
    if (list.length === 0) return;
    const tab = index >= 8 ? list[list.length - 1] : (list[index] ?? undefined);
    if (tab) setActiveTab(tab.path);
  };

  const closeTab = (path: string) => {
    const idx = tabs.findIndex((tab) => tab.path === path);
    const next = tabs.filter((tab) => tab.path !== path);
    setTabs(next);
    if (activeTab === path) setActiveTab(next.length ? next[Math.max(0, idx - 1)].path : null);
  };

  const saveTab = async (path: string, content: string) => {
    try {
      await window.archymedes.writeFile(path, content);
      setTabs((ts) => ts.map((tab) => (tab.path === path ? { ...tab, content, original: content } : tab)));
      notify(t("editor.saved", { name: path.split("/").pop() ?? path }), "success");
      void refreshTree();
    } catch (err) {
      notify(t("editor.saveFailed", { path, error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  const toggleSidebar = () => setSidebarOpen((open) => !open);
  const toggleAgent = () => setAgentOpen((open) => !open);
  const toggleTerminal = () => setTerminalCollapsed((collapsed) => !collapsed);
  const focusTerminal = () => {
    setTerminalCollapsed(false);
    requestAnimationFrame(() => document.dispatchEvent(new CustomEvent("focus-terminal")));
  };

  const files = useMemo(() => flattenFiles(tree), [tree]);

  const commands: Command[] = [
    { id: "quick-open", title: t("cmd.quickOpen"), icon: "search", shortcut: "mod+p", run: () => setOverlay("quickOpen") },
    { id: "open-workspace", title: t("cmd.openWorkspace"), icon: "folder", run: () => void pickWorkspace() },
    { id: "search", title: t("cmd.search"), icon: "search", shortcut: "mod+shift+f", run: () => setOverlay("search") },
    { id: "settings", title: t("cmd.settings"), icon: "settings", shortcut: "mod+,", run: () => setOverlay("settings") },
    { id: "new-chat", title: t("cmd.newChat"), icon: "plus", run: () => agent.reset() },
    { id: "toggle-sidebar", title: t("cmd.toggleSidebar"), icon: "panelStart", shortcut: "mod+b", run: toggleSidebar },
    { id: "toggle-terminal", title: t("cmd.toggleTerminal"), icon: "panelBottom", shortcut: "mod+j", run: toggleTerminal },
    { id: "toggle-agent", title: t("cmd.toggleAgent"), icon: "panelEnd", shortcut: "mod+alt+b", run: toggleAgent },
    { id: "focus-terminal", title: t("cmd.focusTerminal"), icon: "terminal", shortcut: "mod+`", run: focusTerminal },
    ...THEMES.map<Command>((id) => ({
      id: `theme-${id}`,
      title: t("cmd.theme", { name: t(`theme.${id}`) }),
      icon: themeIcon(id),
      run: () => setTheme(id),
    })),
    ...LOCALES.map<Command>((locale) => ({
      id: `language-${locale.code}`,
      title: t("cmd.language", { name: locale.name }),
      icon: "globe",
      run: () => setPreference(locale.code),
    })),
  ];

  // Physical key codes keep shortcuts working on non-Latin keyboard layouts (Arabic, Russian, Hindi…).
  useEffect(() => {
    if (!workspace) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Digit1…9 use physical codes so numpad and layouts both work.
      const digitIndex = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"].indexOf(e.code);
      if (digitIndex !== -1) {
        e.preventDefault();
        activateTabIndex(digitIndex);
        return;
      }
      const handlers: Record<string, (() => void) | undefined> = {
        KeyP: e.shiftKey ? () => setOverlay((o) => (o === "palette" ? null : "palette")) : () => setOverlay("quickOpen"),
        KeyF: e.shiftKey ? () => setOverlay((o) => (o === "search" ? null : "search")) : undefined,
        KeyB: e.altKey ? () => setAgentOpen((open) => !open) : () => setSidebarOpen((open) => !open),
        KeyJ: () => setTerminalCollapsed((collapsed) => !collapsed),
        Backquote: () => {
          setTerminalCollapsed(false);
          requestAnimationFrame(() => document.dispatchEvent(new CustomEvent("focus-terminal")));
        },
        Comma: () => setOverlay("settings"),
      };
      const handler = handlers[e.code];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspace]);

  if (!workspace) {
    return (
      <Welcome
        theme={theme}
        onPick={() => void pickWorkspace()}
        onOpenPath={(p) => void openPath(p)}
        onCycleTheme={() => setTheme(cycleTheme(theme))}
      />
    );
  }

  const workspaceName = workspace.split(/[\\/]/).pop() || workspace;
  const themeName = t(`theme.${theme}`);

  return (
    <div className={`app${resizing ? " resizing" : ""}`}>
      <header className="titlebar">
        <div className="titlebar-brand">
          <Icon name="logo" size={17} />
          <span className="brand-name">Archymedes</span>
        </div>
        <button className="titlebar-workspace" onClick={() => void pickWorkspace()} title={workspace}>
          <Icon name="folder" size={13} />
          <bdi>{workspaceName}</bdi>
          <Icon name="chevronDown" size={11} />
        </button>
        <span className="spacer" />
        {!hasKey && (
          <button className="btn warn small" onClick={() => setOverlay("settings")}>
            <Icon name="alert" size={13} />
            {t("titlebar.noApiKey")}
          </button>
        )}
        <div className="titlebar-group">
          <button
            className={`icon-btn${sidebarOpen ? " pressed" : ""}`}
            onClick={toggleSidebar}
            aria-pressed={sidebarOpen}
            title={`${t("titlebar.toggleSidebar")} (${shortcut("mod+b")})`}
            aria-label={t("titlebar.toggleSidebar")}
          >
            <Icon name="panelStart" size={16} flipRtl />
          </button>
          <button
            className={`icon-btn${terminalCollapsed ? "" : " pressed"}`}
            onClick={toggleTerminal}
            aria-pressed={!terminalCollapsed}
            title={`${t("titlebar.toggleTerminal")} (${shortcut("mod+j")})`}
            aria-label={t("titlebar.toggleTerminal")}
          >
            <Icon name="panelBottom" size={16} />
          </button>
          <button
            className={`icon-btn${agentOpen ? " pressed" : ""}`}
            onClick={toggleAgent}
            aria-pressed={agentOpen}
            title={`${t("titlebar.toggleAgent")} (${shortcut("mod+alt+b")})`}
            aria-label={t("titlebar.toggleAgent")}
          >
            <Icon name="panelEnd" size={16} flipRtl />
          </button>
        </div>
        <LanguageSelect compact />
        <button
          className="icon-btn"
          onClick={() => setTheme(cycleTheme(theme))}
          title={t("titlebar.theme", { name: themeName })}
          aria-label={t("titlebar.theme", { name: themeName })}
        >
          <Icon name={themeIcon(theme)} size={16} />
        </button>
        <button
          className="icon-btn"
          onClick={() => setOverlay("settings")}
          title={`${t("titlebar.settings")} (${shortcut("mod+,")})`}
          aria-label={t("titlebar.settings")}
        >
          <Icon name="settings" size={16} />
        </button>
      </header>

      <div className="main">
        {sidebarOpen && (
          <>
            <div className="pane sidebar-pane" style={{ width: sidebar.size, minWidth: 180 }}>
              <Sidebar
                tree={tree}
                activePath={activeTab}
                editTick={editTick}
                onOpenFile={(p) => void openFile(p)}
                onOpenSearch={() => setOverlay("search")}
                onOpenDiff={setDiffPath}
                onReverted={(p) => reloadCleanTab(p, true)}
              />
            </div>
            <div className="resize-handle vertical" {...sidebar.handleProps} aria-label={t("sidebar.explorer")} />
          </>
        )}

        <div className="center">
          <CodeEditor
            tabs={tabs}
            activeTab={activeTab}
            activeLine={activeLine}
            onActivate={(p) => {
              setActiveTab(p);
              setActiveLine(null);
            }}
            onClose={closeTab}
            onSave={(p, c) => void saveTab(p, c)}
            onChange={(p, c) => setTabs((ts) => ts.map((tab) => (tab.path === p ? { ...tab, content: c } : tab)))}
          />
          {!terminalCollapsed && (
            <div className="resize-handle horizontal" {...terminal.handleProps} aria-label={t("terminal.title")} />
          )}
          <TerminalPanel
            workspace={workspace}
            collapsed={terminalCollapsed}
            height={terminal.size}
            onToggleCollapsed={toggleTerminal}
            onFileChange={() => void refreshTree()}
          />
        </div>

        {agentOpen && (
          <>
            <div className="resize-handle vertical" {...agentPane.handleProps} aria-label="Archymedes" />
            <div className="pane agent-pane" style={{ width: agentPane.size, minWidth: 320 }}>
              <AgentPanel
                agent={agent}
                modelLabel={modelLabel}
                hasKey={hasKey}
                files={files}
                onOpenFile={(p) => void openFile(p)}
                onOpenDiff={setDiffPath}
                onOpenSettings={() => setOverlay("settings")}
              />
            </div>
          </>
        )}
      </div>

      <StatusBar
        status={agent.status}
        usage={agent.usage}
        git={git}
        workspaceName={workspaceName}
        onOpenPalette={() => setOverlay("palette")}
      />

      {overlay === "search" && (
        <SearchPanel
          onOpenFile={(p, line) => {
            setOverlay(null);
            void openFile(p, line);
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "quickOpen" && (
        <QuickOpen
          files={files}
          onClose={() => setOverlay(null)}
          onOpen={(p) => void openFile(p)}
          onOpenAtLine={(p, line) => void openFile(p, line)}
        />
      )}
      {overlay === "palette" && <CommandPalette commands={commands} onClose={() => setOverlay(null)} />}
      {overlay === "settings" && (
        <SettingsModal
          theme={theme}
          scale={scale}
          onThemeChange={setTheme}
          onScaleChange={setScale}
          onClose={() => setOverlay(null)}
          onSaved={applySettingsSummary}
        />
      )}
      {diffPath && (
        <DiffModal
          path={diffPath}
          onClose={() => setDiffPath(null)}
          onReverted={() => {
            setEditTick((n) => n + 1);
            void refreshTree();
            reloadCleanTab(diffPath, true);
          }}
          onOpenFile={(p) => {
            setDiffPath(null);
            void openFile(p);
          }}
        />
      )}
    </div>
  );
}
