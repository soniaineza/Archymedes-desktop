import { app, BrowserWindow, dialog, ipcMain, Notification } from "electron";
import type {
  AgentEvent,
  ChatMessage,
  FileNode,
  ProviderSettings,
  SessionData,
} from "../shared/types";
import { IPC } from "../shared/types";
import {
  getWorkspacePath,
  listDirTree,
  readFileEntry,
  setWorkspacePath,
  writeFileEntry,
} from "./workspace-store";
import { loadSettings, saveSettings } from "./settings";
import { DEFAULT_PROVIDER_SETTINGS } from "../shared/types";
import { getGitInfo } from "./git";
import { workspaceSearch } from "./search";
import { workspaceSymbols } from "./symbols";
import {
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
} from "./sessions";
import { diffFile, revertFile, listEdits } from "./diffs";
import { WorkspaceWatcher } from "./watcher";
import { AgentRunner } from "./agent/runner";
import { TerminalManager } from "./terminal";

/**
 * All IPC handlers. The renderer can only do what is exposed here through the
 * preload bridge — no direct fs, no direct process access.
 */

export function registerIpc(): void {
  const terminalManager = new TerminalManager();
  const watcher = new WorkspaceWatcher();
  let agentRunner: AgentRunner | null = null;

  const send = (channel: string, ...payload: unknown[]): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, ...payload);
    }
  };

  const focused = (): boolean =>
    BrowserWindow.getAllWindows().some((w) => w.isFocused());

  // ---------- workspace / fs ----------

  ipcMain.handle(IPC.PickWorkspace, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose a workspace folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    setWorkspacePath(result.filePaths[0]);
    watcher.stop(); // re-started by the renderer on workspace change
    return getWorkspacePath();
  });

  ipcMain.handle(IPC.GetWorkspace, () => getWorkspacePath());

  ipcMain.handle(IPC.SetWorkspace, (_e, p: string) => {
    setWorkspacePath(p);
  });

  ipcMain.handle(IPC.ListDirTree, (_e, relPath: string): Promise<FileNode[]> =>
    listDirTree(relPath ?? ""),
  );

  ipcMain.handle(IPC.ReadFile, (_e, relPath: string) => readFileEntry(relPath));

  ipcMain.handle(IPC.WriteFile, (_e, relPath: string, content: string) =>
    writeFileEntry(relPath, content),
  );

  // ---------- settings ----------

  ipcMain.handle(IPC.GetSettings, (): Promise<ProviderSettings> => loadSettings());

  ipcMain.handle(IPC.SaveSettings, (_e, settings: ProviderSettings) =>
    saveSettings(settings),
  );

  // ---------- agent ----------

  ipcMain.handle(IPC.AgentSend, async (_e, history: ChatMessage[], sessionId?: string) => {
    const settings = await loadSettings();
    const workspace = getWorkspacePath();
    if (!workspace) throw new Error("No workspace open");
    if (!settings.apiKey && settings.provider !== "ollama") {
      throw new Error(
        "No API key configured. Open Settings (the gear icon) and add your provider key.",
      );
    }
    void sessionId; // reserved for per-session agent state
    agentRunner?.cancel();
    agentRunner = new AgentRunner(settings, workspace, async (event: AgentEvent) => {
      send(IPC.AgentEvent, event);
      // Notify when the run finishes and the window is not focused.
      if (event.type === "status" && event.status === "idle" && !focused()) {
        if (Notification.isSupported()) {
          new Notification({ title: "Archymedes", body: "Agent finished — take a look." }).show();
        }
      }
    });
    await agentRunner.run(history);
  });

  ipcMain.handle(IPC.AgentCancel, () => {
    agentRunner?.cancel();
  });

  // ---------- git / search ----------

  ipcMain.handle(IPC.GetGitInfo, () => {
    const workspace = getWorkspacePath();
    return workspace ? getGitInfo(workspace) : Promise.resolve({ isRepo: false, branch: "", dirtyCount: 0 });
  });

  ipcMain.handle(IPC.WorkspaceSearch, (_e, query: string, caseSensitive?: boolean) =>
    workspaceSearch(query, caseSensitive === true),
  );

  ipcMain.handle(IPC.WorkspaceSymbols, (_e, query: string) => {
    const workspace = getWorkspacePath();
    return workspace
      ? workspaceSymbols(workspace, query)
      : Promise.resolve({ hits: [], truncated: false });
  });

  // ---------- sessions ----------

  ipcMain.handle(IPC.SessionList, () => listSessions(app.getPath("userData")));

  ipcMain.handle(IPC.SessionLoad, (_e, id: string) => loadSession(app.getPath("userData"), id));

  ipcMain.handle(IPC.SessionSave, (_e, session: SessionData) =>
    saveSession(app.getPath("userData"), session),
  );

  ipcMain.handle(IPC.SessionDelete, (_e, id: string) =>
    deleteSession(app.getPath("userData"), id),
  );

  ipcMain.handle(IPC.SessionRename, (_e, id: string, title: string) =>
    renameSession(app.getPath("userData"), id, title),
  );

  // ---------- diffs / revert ----------

  ipcMain.handle(IPC.DiffFile, (_e, relPath: string) =>
    diffFile(app.getPath("userData"), relPath),
  );

  ipcMain.handle(IPC.RevertFile, (_e, relPath: string) => {
    const result = revertFile(app.getPath("userData"), relPath);
    send(IPC.WatchEvent, { changed: true });
    return result;
  });

  ipcMain.handle(IPC.ListEdits, () => listEdits(app.getPath("userData")));

  // ---------- watcher ----------

  ipcMain.handle(IPC.WatchStart, () => {
    const workspace = getWorkspacePath();
    if (workspace) {
      watcher.start(workspace, () => send(IPC.WatchEvent, { changed: true }));
    }
  });

  ipcMain.handle(IPC.WatchStop, () => watcher.stop());

  // ---------- terminal ----------

  ipcMain.handle(IPC.TerminalCreate, async (_e, cwd?: string, shellOverride?: string) => {
    // Load settings so the terminal honors the user's shell choice; falls
    // back to defaults if settings can't be read. The per-tab override wins
    // over the global Settings value.
    const settings = await loadSettings().catch(() => DEFAULT_PROVIDER_SETTINGS);
    const valid = ["default", "powershell", "cmd", "gitbash", "custom"];
    const override = shellOverride && valid.includes(shellOverride)
      ? (shellOverride as Parameters<TerminalManager["create"]>[2])
      : undefined;
    const { id, warning, shellLabel } = await terminalManager.create(
      settings,
      cwd ?? getWorkspacePath() ?? undefined,
      override,
    );
    const session = terminalManager.get(id);
    if (session) {
      session.pty.onData((data) => send(IPC.TerminalData, id, data));
      session.pty.onExit(({ exitCode }) => {
        send(IPC.TerminalExit, id, exitCode);
        terminalManager.onExit(id);
      });
    }
    return { id, warning, shellLabel };
  });

  ipcMain.on(IPC.TerminalKill, (_e, id: string) => terminalManager.kill(id));

  ipcMain.on(IPC.TerminalWrite, (_e, id: string, data: string) =>
    terminalManager.write(id, data),
  );

  ipcMain.on(IPC.TerminalResize, (_e, id: string, cols: number, rows: number) =>
    terminalManager.resize(id, cols, rows),
  );

  // Kill PTYs and stop the watcher when the app quits; without this, spawned
  // shells can outlive the window on Windows.
  app.on("before-quit", () => {
    terminalManager.disposeAll();
    watcher.stop();
    agentRunner?.cancel();
  });
}
