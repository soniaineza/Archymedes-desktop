import type {
  AgentEvent,
  ChatMessage,
  EditSummary,
  FileDiff,
  FileEntry,
  FileNode,
  GitInfo,
  ProviderSettings,
  SymbolHit,
  SearchResult,
  SessionData,
  SessionSummary,
  TerminalInfo,
} from "./types";

/**
 * The complete main ↔ renderer contract. Each channel is declared once, here.
 * The main-process handlers, the preload bridge and ArchymedesApi are all typed
 * from these maps, so a handler and its caller cannot drift apart silently.
 */

/** Request/response: ipcRenderer.invoke → ipcMain.handle. */
export interface IpcInvokeMap {
  "fs:pick-workspace": { args: [dialogTitle?: string]; result: string | null };
  "fs:get-workspace": { args: []; result: string | null };
  "fs:set-workspace": { args: [path: string]; result: void };
  "fs:list-tree": { args: [relPath: string]; result: FileNode[] };
  "fs:read-file": { args: [relPath: string]; result: FileEntry };
  "fs:write-file": { args: [relPath: string, content: string]; result: void };

  "settings:get": { args: []; result: ProviderSettings };
  "settings:save": { args: [settings: ProviderSettings]; result: void };

  "agent:send": { args: [history: ChatMessage[]]; result: void };
  "agent:cancel": { args: []; result: void };

  "git:get-info": { args: []; result: GitInfo };
  "search:workspace": { args: [query: string, caseSensitive?: boolean]; result: SearchResult };
  "symbols:workspace": { args: [query: string]; result: { hits: SymbolHit[]; truncated: boolean } };

  "session:list": { args: []; result: SessionSummary[] };
  "session:load": { args: [id: string]; result: SessionData | null };
  "session:save": { args: [session: SessionData]; result: void };
  "session:delete": { args: [id: string]; result: void };
  "session:rename": { args: [id: string, title: string]; result: void };

  "diff:file": { args: [relPath: string]; result: FileDiff | null };
  "diff:revert": { args: [relPath: string]; result: void };
  "diff:list-edits": { args: []; result: EditSummary[] };

  "watch:start": { args: []; result: void };
  "watch:stop": { args: []; result: void };

  "term:create": { args: [cwd?: string, shell?: string]; result: TerminalInfo };
}

/** Fire-and-forget: ipcRenderer.send → ipcMain.on. */
export interface IpcSendMap {
  "term:write": [id: string, data: string];
  "term:resize": [id: string, cols: number, rows: number];
  "term:kill": [id: string];
}

/** Pushes: webContents.send → ipcRenderer.on. */
export interface IpcEventMap {
  "agent:event": [event: AgentEvent];
  "watch:event": [event: { changed: boolean }];
  "term:data": [id: string, data: string];
  "term:exit": [id: string, code: number];
}

export type InvokeChannel = keyof IpcInvokeMap;
export type SendChannel = keyof IpcSendMap;
export type EventChannel = keyof IpcEventMap;
export type InvokeArgs<K extends InvokeChannel> = IpcInvokeMap[K]["args"];
export type InvokeResult<K extends InvokeChannel> = IpcInvokeMap[K]["result"];

type Invoke<K extends InvokeChannel> = (...args: InvokeArgs<K>) => Promise<InvokeResult<K>>;
type Send<K extends SendChannel> = (...args: IpcSendMap[K]) => void;
type Subscribe<K extends EventChannel> = (handler: (...payload: IpcEventMap[K]) => void) => () => void;

/** What the preload exposes as `window.archymedes`. */
export interface ArchymedesApi {
  // window (handled in the preload, not over IPC)
  setZoomFactor(factor: number): void;

  // fs
  pickWorkspace: Invoke<"fs:pick-workspace">;
  getWorkspace: Invoke<"fs:get-workspace">;
  setWorkspace: Invoke<"fs:set-workspace">;
  listDirTree: Invoke<"fs:list-tree">;
  readFile: Invoke<"fs:read-file">;
  writeFile: Invoke<"fs:write-file">;

  // settings
  getSettings: Invoke<"settings:get">;
  saveSettings: Invoke<"settings:save">;

  // agent
  sendAgentMessage: Invoke<"agent:send">;
  cancelAgent: Invoke<"agent:cancel">;
  onAgentEvent: Subscribe<"agent:event">;

  // git / search / symbols
  getGitInfo: Invoke<"git:get-info">;
  workspaceSearch: Invoke<"search:workspace">;
  workspaceSymbols: Invoke<"symbols:workspace">;

  // sessions
  listSessions: Invoke<"session:list">;
  loadSession: Invoke<"session:load">;
  saveSession: Invoke<"session:save">;
  deleteSession: Invoke<"session:delete">;
  renameSession: Invoke<"session:rename">;

  // diffs / revert
  diffFile: Invoke<"diff:file">;
  revertFile: Invoke<"diff:revert">;
  listEdits: Invoke<"diff:list-edits">;

  // watcher
  startWatching: Invoke<"watch:start">;
  stopWatching: Invoke<"watch:stop">;
  onWatchEvent: Subscribe<"watch:event">;

  // terminal
  createTerminal: Invoke<"term:create">;
  terminalWrite: Send<"term:write">;
  terminalResize: Send<"term:resize">;
  terminalKill: Send<"term:kill">;
  onTerminalData: Subscribe<"term:data">;
  onTerminalExit: Subscribe<"term:exit">;
}
