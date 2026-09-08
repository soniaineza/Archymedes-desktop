import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileNode } from "@shared/types";
import { Sidebar } from "./components/Sidebar";
import { AgentPanel } from "./components/AgentPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { SettingsModal } from "./components/SettingsModal";
import { CommandPalette } from "./components/CommandPalette";
import type { Command } from "./components/CommandPalette";
import { QuickOpen } from "./components/QuickOpen";
import { SearchPanel } from "./components/SearchPanel";
import { DiffModal } from "./components/DiffModal";
import { StatusBar, useGitStatus } from "./components/StatusBar";
import { CodeEditor } from "./components/CodeEditor";
import { Welcome, pushRecent } from "./components/Welcome";
import { getTheme, applyTheme, cycleTheme, THEMES } from "./lib/theme";
import type { Theme } from "./lib/theme";
import { useAgent } from "./lib/useAgent";
import type { OpenTab } from "./lib/tabs";

function flattenFiles(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n.path);
    if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState("");
  const [theme, setTheme] = useState(getTheme());

  const setThemeAndApply = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  const toggleTheme = () => setThemeAndApply(cycleTheme(theme));
  const [, setEditTick] = useState(0);
  const tabsRef = useRef<OpenTab[]>([]);
  tabsRef.current = tabs;

  const agent = useAgent();
  const git = useGitStatus(workspace);

  const refreshTree = useCallback(async () => {
    if (!workspace) return;
    try {
      setTree(await window.archymedes.listDirTree(""));
    } catch {
      setTree([]);
    }
  }, [workspace]);

  useEffect(() => {
    applyTheme(getTheme());
    void window.archymedes.getWorkspace().then(setWorkspace);
    void window.archymedes.getSettings().then((s) => {
      setHasKey(Boolean(s.apiKey));
      setModel(`${s.provider} · ${s.model}`);
    });
  }, []);

  useEffect(() => {
    void refreshTree();
    if (workspace) void window.archymedes.startWatching();
    return () => {
      void window.archymedes.stopWatching();
    };
  }, [refreshTree, workspace]);

  // Watcher events: refresh tree, reload clean tabs, bump the edits box.
  useEffect(() => {
    const off = window.archymedes.onWatchEvent(() => {
      void refreshTree();
      setEditTick((t) => t + 1);
      setTabs((ts) =>
        ts.map((tab) => {
          if (tab.content === tab.original) {
            void window.archymedes.readFile(tab.path).then((entry) => {
              setTabs((cur) =>
                cur.map((t) =>
                  t.path === tab.path && t.content === t.original
                    ? { ...t, content: entry.content, original: entry.content, truncated: entry.truncated }
                    : t,
                ),
              );
            });
          }
          return tab;
        }),
      );
    });
    return off;
  }, [refreshTree]);

  const pickWorkspace = async () => {
    const p = await window.archymedes.pickWorkspace();
    if (p) {
      pushRecent(p);
      setWorkspace(p);
      setTabs([]);
      setActiveTab(null);
      agent.reset();
    }
  };

  const openPath = async (p: string) => {
    await window.archymedes.setWorkspace(p);
    pushRecent(p);
    setWorkspace(p);
    setTabs([]);
    setActiveTab(null);
    agent.reset();
  };

  const openFile = async (path: string, line?: number) => {
    setActiveLine(line ?? null);
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      setActiveTab(path);
      return;
    }
    try {
      const entry = await window.archymedes.readFile(path);
      setTabs((ts) => [...ts, { path, content: entry.content, original: entry.content, truncated: entry.truncated }]);
      setActiveTab(path);
    } catch (err) {
      agent.pushLocalError(`Cannot open ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const closeTab = (path: string) => {
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.path === path);
      const next = ts.filter((t) => t.path !== path);
      if (activeTab === path) {
        setActiveTab(next.length ? next[Math.max(0, idx - 1)].path : null);
      }
      return next;
    });
  };

  const saveTab = async (path: string, content: string) => {
    await window.archymedes.writeFile(path, content);
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, content, original: content } : t)));
    void refreshTree();
  };

  const commands: Command[] = useMemo(
    () => [
      { id: "quick-open", title: "Quick Open File…", hint: "Ctrl+P", run: () => setQuickOpen(true) },
      { id: "open-workspace", title: "Open Workspace…", hint: "folder", run: () => void pickWorkspace() },
      { id: "settings", title: "Settings", hint: "provider, API key", run: () => setSettingsOpen(true) },
      { id: "search", title: "Search in Files", hint: "Ctrl+Shift+F", run: () => setSearchOpen(true) },
      { id: "toggle-sidebar", title: "Toggle Sidebar", hint: "Ctrl+B", run: () => setSidebarOpen((o) => !o) },
      { id: "new-chat", title: "New Agent Chat", hint: "/clear", run: () => agent.reset() },
      { id: "focus-terminal", title: "Focus Terminal", hint: "Ctrl+`", run: () => document.dispatchEvent(new CustomEvent("focus-terminal")) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("toggle-terminal"));
      } else if (mod && e.key === "`") {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("focus-terminal"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!workspace) {
    return <Welcome onPick={() => void pickWorkspace()} onOpenPath={(p) => void openPath(p)} />;
  }

  const workspaceName = workspace.split(/[\\/]/).pop() ?? workspace;

  return (
    <div className="app">
      <div className="titlebar">
        <span className="logo">▣ ARCHYMEDES</span>
        <span className="workspace-name">{workspace}</span>
        <span className="spacer" />
        {!hasKey && (
          <button className="warn-btn" onClick={() => setSettingsOpen(true)}>
            ⚠ no API key
          </button>
        )}
        <button
          onClick={toggleTheme}
          title="Cycle theme (also in Settings)"
        >
          {THEMES.find((t) => t.id === theme)?.label ?? theme}
        </button>
        <button onClick={() => void pickWorkspace()}>open…</button>
        <button onClick={() => setSettingsOpen(true)}>settings</button>
      </div>

      <div className="main">
        {sidebarOpen && (
          <Sidebar
            tree={tree}
            activePath={activeTab}
            onOpenFile={(p) => void openFile(p)}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenDiff={(p) => setDiffPath(p)}
          />
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
            onChange={(p, c) => setTabs((ts) => ts.map((t) => (t.path === p ? { ...t, content: c } : t)))}
          />
          <TerminalPanel workspace={workspace} onFileChange={() => void refreshTree()} />
        </div>

        <AgentPanel
          agent={agent}
          model={model}
          onOpenFile={(p) => void openFile(p)}
          onOpenDiff={(p) => setDiffPath(p)}
          onRefreshTree={() => void refreshTree()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      <StatusBar status={agent.status} usage={agent.usage} git={git} workspaceName={workspaceName} />

      {searchOpen && (
        <SearchPanel
          onOpenFile={(p, line) => {
            void openFile(p, line);
            setSearchOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {quickOpen && (
        <QuickOpen
          files={flattenFiles(tree)}
          onClose={() => setQuickOpen(false)}
          onOpen={(p) => void openFile(p)}
        />
      )}

      {diffPath && (
        <DiffModal
          path={diffPath}
          onClose={() => setDiffPath(null)}
          onReverted={() => {
            void refreshTree();
            setEditTick((t) => t + 1);
            void window.archymedes.readFile(diffPath).then((entry) => {
              setTabs((ts) => ts.map((t) => (t.path === diffPath ? { ...t, content: entry.content, original: entry.content } : t)));
            });
          }}
          onOpenFile={(p) => {
            setDiffPath(null);
            void openFile(p);
          }}
        />
      )}

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => {
            setHasKey(Boolean(s.apiKey));
            setModel(`${s.provider} · ${s.model}`);
          }}
        />
      )}
    </div>
  );
}
