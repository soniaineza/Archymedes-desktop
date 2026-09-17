import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  ArchymedesApi,
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  IpcEventMap,
  IpcSendMap,
  SendChannel,
} from "../shared/ipc-contract";

/**
 * The only bridge between the renderer and the main process. Every call goes
 * through the typed contract in shared/ipc-contract.ts; nothing else crosses.
 */

function invoke<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeResult<K>> {
  return ipcRenderer.invoke(channel, ...args);
}

function send<K extends SendChannel>(channel: K, ...args: IpcSendMap[K]): void {
  ipcRenderer.send(channel, ...args);
}

function subscribe<K extends EventChannel>(channel: K, handler: (...payload: IpcEventMap[K]) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...payload: unknown[]) => handler(...(payload as IpcEventMap[K]));
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: ArchymedesApi = {
  setZoomFactor: (factor) => {
    if (Number.isFinite(factor) && factor >= 0.5 && factor <= 2) webFrame.setZoomFactor(factor);
  },

  pickWorkspace: (...args) => invoke("fs:pick-workspace", ...args),
  getWorkspace: () => invoke("fs:get-workspace"),
  setWorkspace: (...args) => invoke("fs:set-workspace", ...args),
  listDirTree: (...args) => invoke("fs:list-tree", ...args),
  readFile: (...args) => invoke("fs:read-file", ...args),
  writeFile: (...args) => invoke("fs:write-file", ...args),

  getSettings: () => invoke("settings:get"),
  saveSettings: (...args) => invoke("settings:save", ...args),

  sendAgentMessage: (...args) => invoke("agent:send", ...args),
  cancelAgent: () => invoke("agent:cancel"),
  approveCommand: (...args) => invoke("agent:approve", ...args),
  onAgentEvent: (handler) => subscribe("agent:event", handler),

  getGitInfo: () => invoke("git:get-info"),
  workspaceSearch: (...args) => invoke("search:workspace", ...args),
  workspaceSymbols: (...args) => invoke("symbols:workspace", ...args),

  listSessions: () => invoke("session:list"),
  loadSession: (...args) => invoke("session:load", ...args),
  saveSession: (...args) => invoke("session:save", ...args),
  deleteSession: (...args) => invoke("session:delete", ...args),
  renameSession: (...args) => invoke("session:rename", ...args),

  diffFile: (...args) => invoke("diff:file", ...args),
  revertFile: (...args) => invoke("diff:revert", ...args),
  listEdits: () => invoke("diff:list-edits"),

  startWatching: () => invoke("watch:start"),
  stopWatching: () => invoke("watch:stop"),
  onWatchEvent: (handler) => subscribe("watch:event", handler),

  createTerminal: (...args) => invoke("term:create", ...args),
  terminalWrite: (...args) => send("term:write", ...args),
  terminalResize: (...args) => send("term:resize", ...args),
  terminalKill: (...args) => send("term:kill", ...args),
  onTerminalData: (handler) => subscribe("term:data", handler),
  onTerminalExit: (handler) => subscribe("term:exit", handler),
};

contextBridge.exposeInMainWorld("archymedes", api);
