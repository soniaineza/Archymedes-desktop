import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileNode, ProviderSettings } from "@shared/types";
import { formatModelLabel, PROVIDER_INFO } from "@shared/providers";
import { AgentPanel } from "./components/AgentPanel";
import type { ChatRequest } from "./components/AgentPanel";
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
import { StatusBar } from "./components/StatusBar";
import { useGitStatus } from "./lib/useGitStatus";
import { TerminalPanel } from "./components/TerminalPanel";
import { useToast } from "./components/Toasts";
import { Welcome } from "./components/Welcome";
import { useI18n } from "./i18n/I18nProvider";
import { LOCALES } from "./i18n/locales";
import { flattenFiles } from "./lib/files";
import { pushRecent } from "./lib/recent";
import type { OpenTab } from "./lib/tabs";
import { isDirty } from "./lib/tabs";
import { applyPrefsToDocument, getPrefs, setPref, usePrefs } from "./lib/prefs";
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
  const [provider, setProvider] = useState<ProviderSettings["provider"] | null>(null);
  /** Free mode without a key or a gateway cannot run yet; the welcome screen then shows its setup. */
  const [freeNeedsSetup, setFreeNeedsSetup] = useState(false);
  const [editTick, setEditTick] = useState(0);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [scale, setScale] = useState(() => readStored("archymedes.scale", parseScale, 1));
  const [sidebarOpen, setSidebarOpen] = useState(() => readStored("archymedes.sidebar-open", parseBool, true));
  const [agentOpen, setAgentOpen] = useState(() => readStored("archymedes.agent-open", parseBool, true));
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null);
  const prefs = usePrefs();
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
  useEffect(() => applyPrefsToDocument(prefs), [prefs]);
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
    setProvider(s.provider);
    if (s.provider !== "free") setFreeNeedsSetup(false);
    else {
      window.archymedes.isFreeReady().then(
        (ready) => setFreeNeedsSetup(!ready),
        () => setFreeNeedsSetup(false),
      );
    }
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
    // Chats are per project: the list has to be re-read for the folder just opened.
    void agent.refreshSessions();
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
    const closing = tabs.find((tab) => tab.path === path);
    if (
      closing &&
      isDirty(closing) &&
      getPrefs().confirmCloseDirty &&
      !window.confirm(t("editor.confirmClose", { name: path.split("/").pop() ?? path }))
    ) {
      return;
    }
    const idx = tabs.findIndex((tab) => tab.path === path);
    const next = tabs.filter((tab) => tab.path !== path);
    setTabs(next);
    if (activeTab === path) setActiveTab(next.length ? next[Math.max(0, idx - 1)].path : null);
  };

  const savingRef = useRef(new Set<string>());
  const saveTab = async (path: string, content: string, options: { quiet?: boolean } = {}) => {
    if (savingRef.current.has(path)) return;
    savingRef.current.add(path);
    try {
      await window.archymedes.writeFile(path, content);
      // Only the saved text becomes the baseline: anything typed during the write stays dirty.
      setTabs((ts) => ts.map((tab) => (tab.path === path ? { ...tab, original: content } : tab)));
      if (!options.quiet) notify(t("editor.saved", { name: path.split("/").pop() ?? path }), "success");
      void refreshTree();
    } catch (err) {
      notify(t("editor.saveFailed", { path, error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      savingRef.current.delete(path);
    }
  };

  /** Auto save never touches read-only (truncated) tabs, which could not be written in full. */
  const autoSave = (paths?: readonly string[]) => {
    for (const tab of tabsRef.current) {
      if (tab.truncated || !isDirty(tab)) continue;
      if (paths && !paths.includes(tab.path)) continue;
      void saveTab(tab.path, tab.content, { quiet: true });
    }
  };
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;

  // Auto save "after delay": every edit restarts the timer.
  useEffect(() => {
    if (prefs.autoSave !== "afterDelay" || !tabs.some((tab) => !tab.truncated && isDirty(tab))) return;
    const timer = setTimeout(() => autoSaveRef.current(), prefs.autoSaveDelay);
    return () => clearTimeout(timer);
  }, [tabs, prefs.autoSave, prefs.autoSaveDelay]);

  // Auto save "when focus changes": switching tabs or leaving the window saves.
  const previousTabRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousTabRef.current;
    previousTabRef.current = activeTab;
    if (getPrefs().autoSave === "onFocusChange" && previous && previous !== activeTab) autoSaveRef.current([previous]);
  }, [activeTab]);
  useEffect(() => {
    const onBlur = () => {
      if (getPrefs().autoSave !== "off") autoSaveRef.current();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  const toggleSidebar = () => setSidebarOpen((open) => !open);
  const toggleAgent = () => setAgentOpen((open) => !open);
  const toggleTerminal = () => setTerminalCollapsed((collapsed) => !collapsed);
  const focusTerminal = () => {
    setTerminalCollapsed(false);
    requestAnimationFrame(() => document.dispatchEvent(new CustomEvent("focus-terminal")));
  };

  /** Show the chat pane (if hidden) and focus its message box, or open the past-chats list. */
  const requestChat = useCallback((kind: ChatRequest["kind"]) => {
    setAgentOpen(true);
    setChatRequest({ kind, id: Date.now() + Math.random() });
  }, []);
  // A hidden pane forgets the last request, so reopening it later doesn't replay it.
  useEffect(() => {
    if (!agentOpen) setChatRequest(null);
  }, [agentOpen]);
  const goToChat = () => requestChat("focus");
  const openChatHistory = () => {
    void agent.refreshSessions();
    requestChat("history");
  };

  // After Settings, the command palette or the diff viewer closes, go back to the chat box
  // when the chat is open and nothing else took focus.
  const agentOpenRef = useRef(agentOpen);
  agentOpenRef.current = agentOpen;
  const returnsToChat = overlay === "settings" || overlay === "palette" || diffPath !== null;
  const returnsToChatRef = useRef(false);
  useEffect(() => {
    const wasOpen = returnsToChatRef.current;
    returnsToChatRef.current = returnsToChat;
    if (!wasOpen || returnsToChat || overlay !== null || !agentOpenRef.current) return;
    const frame = requestAnimationFrame(() => {
      const el = document.activeElement;
      const busyElsewhere =
        el instanceof HTMLElement && (el.matches("input, textarea, select, [contenteditable='true']") || el.closest(".xterm"));
      if (!busyElsewhere) requestChat("focus");
    });
    return () => cancelAnimationFrame(frame);
  }, [returnsToChat, overlay, requestChat]);

  // Restore the most recent chat on startup.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!workspace || restoredRef.current) return;
    restoredRef.current = true;
    void window.archymedes
      .listSessions()
      .then((list) => {
        if (!getPrefs().restoreLastChat || list.length === 0) return;
        void agent.switchTo(list[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const files = useMemo(() => flattenFiles(tree), [tree]);

  const commands: Command[] = [
    { id: "quick-open", title: t("cmd.quickOpen"), icon: "search", shortcut: "mod+p", run: () => setOverlay("quickOpen") },
    { id: "open-workspace", title: t("cmd.openWorkspace"), icon: "folder", run: () => void pickWorkspace() },
    { id: "search", title: t("cmd.search"), icon: "search", shortcut: "mod+shift+f", run: () => setOverlay("search") },
    { id: "settings", title: t("cmd.settings"), icon: "settings", shortcut: "mod+,", run: () => setOverlay("settings") },
    { id: "go-to-chat", title: t("cmd.goToChat"), icon: "message", shortcut: "mod+l", run: goToChat },
    { id: "chat-history", title: t("cmd.chatHistory"), icon: "history", shortcut: "mod+h", run: openChatHistory },
    { id: "delete-chat", title: t("cmd.deleteChat"), icon: "trash", run: () => void agent.removeSession(agent.session.id) },
    {
      id: "new-chat",
      title: t("cmd.newChat"),
      icon: "plus",
      run: () => {
        agent.reset();
        goToChat();
      },
    },
    {
      id: "toggle-word-wrap",
      title: t("cmd.toggleWordWrap"),
      icon: "code",
      shortcut: "alt+z",
      run: () => setPref("editorWordWrap", !getPrefs().editorWordWrap),
    },
    {
      id: "toggle-auto-save",
      title: getPrefs().autoSave === "off" ? t("cmd.autoSaveOn") : t("cmd.autoSaveOff"),
      icon: "check",
      run: () => setPref("autoSave", getPrefs().autoSave === "off" ? "afterDelay" : "off"),
    },
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

  const chatShortcutRef = useRef<(kind: ChatRequest["kind"]) => void>(() => {});
  chatShortcutRef.current = (kind) => (kind === "focus" ? goToChat() : openChatHistory());

  // Physical key codes keep shortcuts working on non-Latin keyboard layouts (Arabic, Russian, Hindi…).
  useEffect(() => {
    if (!workspace) return;
    const onKey = (e: KeyboardEvent) => {
      // Alt+Z toggles word wrap, as in VS Code.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        setPref("editorWordWrap", !getPrefs().editorWordWrap);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      // Ctrl+L / Ctrl+H mean "clear screen" / "backspace" to a shell: leave them to the terminal.
      const inTerminal = e.target instanceof Element && e.target.closest(".terminal-panel, .xterm") !== null;
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
        KeyL: !e.shiftKey && !e.altKey && !inTerminal ? () => chatShortcutRef.current("focus") : undefined,
        KeyH: !e.shiftKey && !e.altKey && !inTerminal ? () => chatShortcutRef.current("history") : undefined,
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
        needsKey={!hasKey}
        freeSetup={freeNeedsSetup}
        onSettingsSaved={applySettingsSummary}
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
        {(!hasKey || freeNeedsSetup) && (
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
                chats={agent.sessions}
                currentChatId={agent.session.id}
                onOpenChat={(id) => {
                  void agent.switchTo(id);
                  goToChat();
                }}
                onShowAllChats={openChatHistory}
                onDeleteChat={(id) => void agent.removeSession(id)}
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
            onBlur={(p) => {
              if (getPrefs().autoSave === "onFocusChange") autoSave([p]);
            }}
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
                provider={provider}
                files={files}
                onOpenFile={(p) => void openFile(p)}
                onOpenDiff={setDiffPath}
                onOpenSettings={() => setOverlay("settings")}
                request={chatRequest}
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
