import { contextBridge, ipcRenderer } from "electron";
import type { ArchymedesApi, AgentEvent } from "../shared/types";
import { IPC } from "../shared/types";

/**
 * The only bridge between the sandboxed renderer and the main process.
 * Exposes a narrow, typed API; nothing else crosses the boundary.
 */

const api: ArchymedesApi = {
  // fs
  pickWorkspace: () => ipcRenderer.invoke(IPC.PickWorkspace),
  getWorkspace: () => ipcRenderer.invoke(IPC.GetWorkspace),
  setWorkspace: (p) => ipcRenderer.invoke(IPC.SetWorkspace, p),
  listDirTree: (p) => ipcRenderer.invoke(IPC.ListDirTree, p),
  readFile: (p) => ipcRenderer.invoke(IPC.ReadFile, p),
  writeFile: (p, c) => ipcRenderer.invoke(IPC.WriteFile, p, c),

  // settings
  getSettings: () => ipcRenderer.invoke(IPC.GetSettings),
  saveSettings: (s) => ipcRenderer.invoke(IPC.SaveSettings, s),

  // agent
  sendAgentMessage: (history, sessionId) =>
    ipcRenderer.invoke(IPC.AgentSend, history, sessionId),
  cancelAgent: () => ipcRenderer.invoke(IPC.AgentCancel),
  onAgentEvent: (handler) => {
    const listener = (_e: unknown, event: AgentEvent): void => {
      handler(event);
    };
    ipcRenderer.on(IPC.AgentEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.AgentEvent, listener);
    };
  },

  // git
  getGitInfo: () => ipcRenderer.invoke(IPC.GetGitInfo),

  // search
  workspaceSearch: (query, caseSensitive) =>
    ipcRenderer.invoke(IPC.WorkspaceSearch, query, caseSensitive),
  workspaceSymbols: (query) => ipcRenderer.invoke(IPC.WorkspaceSymbols, query),

  // sessions
  listSessions: () => ipcRenderer.invoke(IPC.SessionList),
  loadSession: (id) => ipcRenderer.invoke(IPC.SessionLoad, id),
  saveSession: (session) => ipcRenderer.invoke(IPC.SessionSave, session),
  deleteSession: (id) => ipcRenderer.invoke(IPC.SessionDelete, id),
  renameSession: (id, title) => ipcRenderer.invoke(IPC.SessionRename, id, title),

  // diffs / revert
  diffFile: (p) => ipcRenderer.invoke(IPC.DiffFile, p),
  revertFile: (p) => ipcRenderer.invoke(IPC.RevertFile, p),
  listEdits: () => ipcRenderer.invoke(IPC.ListEdits),

  // watcher
  startWatching: () => ipcRenderer.invoke(IPC.WatchStart),
  stopWatching: () => ipcRenderer.invoke(IPC.WatchStop),
  onWatchEvent: (handler) => {
    const listener = (_e: unknown, event: { changed: boolean }): void => {
      handler(event);
    };
    ipcRenderer.on(IPC.WatchEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.WatchEvent, listener);
    };
  },

  // terminal
  createTerminal: (cwd, shell) => ipcRenderer.invoke(IPC.TerminalCreate, cwd, shell),
  killTerminal: (id) => ipcRenderer.send(IPC.TerminalKill, id),
  terminalWrite: (id, data) => ipcRenderer.send(IPC.TerminalWrite, id, data),
  terminalResize: (id, cols, rows) =>
    ipcRenderer.send(IPC.TerminalResize, id, cols, rows),
  onTerminalData: (handler) => {
    const listener = (_e: unknown, id: string, data: string): void => {
      handler(id, data);
    };
    ipcRenderer.on(IPC.TerminalData, listener);
    return () => {
      ipcRenderer.removeListener(IPC.TerminalData, listener);
    };
  },
  onTerminalExit: (handler) => {
    const listener = (_e: unknown, id: string, code: number): void => {
      handler(id, code);
    };
    ipcRenderer.on(IPC.TerminalExit, listener);
    return () => {
      ipcRenderer.removeListener(IPC.TerminalExit, listener);
    };
  },
};

contextBridge.exposeInMainWorld("archymedes", api);
