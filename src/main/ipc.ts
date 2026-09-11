import { BrowserWindow, dialog, ipcMain } from "electron";
import type {
  AgentEvent,
  ChatMessage,
  FileNode,
  ProviderSettings,
  SessionData,
} from "../shared/types";
import { AGENT_ERROR_CODES, IPC } from "../shared/types";
import {
  getWorkspacePath,
  listDirTree,
  readFileEntry,
  setWorkspacePath,
  writeFileEntry,
} from "./workspace-store";
import { loadSettings, saveSettings } from "./settings";
import { getGitInfo } from "./git";
import { workspaceSearch } from "./search";
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
import { app } from "electron";

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

  // ---------- workspace / fs ----------

  ipcMain.handle(IPC.PickWorkspace, async (e, dialogTitle?: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: typeof dialogTitle === "string" && dialogTitle.trim() ? dialogTitle.slice(0, 200) : "Choose a workspace folder",
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

  // Errors carry stable codes; the renderer shows them in the user's language.
  ipcMain.handle(IPC.AgentSend, async (_e, history: ChatMessage[]) => {
    const settings = await loadSettings();
    const workspace = getWorkspacePath();
    if (!workspace) throw new Error(AGENT_ERROR_CODES.noWorkspace);
    if (!settings.apiKey && settings.provider !== "ollama") {
      throw new Error(AGENT_ERROR_CODES.noApiKey);
    }
    agentRunner?.cancel();
    agentRunner = new AgentRunner(settings, workspace, (event: AgentEvent) => send(IPC.AgentEvent, event));
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

  ipcMain.handle(IPC.WorkspaceSearch, (_e, query: string) => workspaceSearch(query));

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

  ipcMain.handle(IPC.TerminalCreate, (_e, cwd?: string) => {
    const { id } = terminalManager.create(cwd ?? getWorkspacePath() ?? undefined);
    const session = terminalManager.get(id);
    if (session) {
      session.pty.onData((data) => send(IPC.TerminalData, id, data));
      session.pty.onExit(({ exitCode }) => {
        send(IPC.TerminalExit, id, exitCode);
        terminalManager.onExit(id);
      });
    }
    return { id };
  });

  ipcMain.on(IPC.TerminalWrite, (_e, id: string, data: string) =>
    terminalManager.write(id, data),
  );

  ipcMain.on(IPC.TerminalResize, (_e, id: string, cols: number, rows: number) =>
    terminalManager.resize(id, cols, rows),
  );
}
