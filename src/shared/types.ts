/**
 * Shared types used by main, preload, and renderer.
 * Kept dependency-free so all three builds can import it.
 */

// ---------- Filesystem / workspace ----------

export interface FileNode {
  name: string;
  path: string; // workspace-relative, forward slashes
  kind: "file" | "dir";
  children?: FileNode[];
}

export interface FileEntry {
  path: string;
  content: string;
  truncated?: boolean;
}

// ---------- Agent ----------

export type ChatRole = "user" | "assistant" | "system";

export interface ToolCallInfo {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolCalls?: ToolCallInfo[];
  pending?: boolean;
}

export type AgentStatus =
  | "idle"
  | "thinking"
  | "calling-tool"
  | "awaiting-model"
  | "error";

export interface ProviderSettings {
  /** Which adapter to use. */
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** Base URL override; empty = adapter default. */
  baseUrl: string;
  maxIterations: number;
  /** ISO currency code for cost display (from the CLI's multi-currency ledger). */
  currency: string;
}

/**
 * The 9 providers the CLI core defines. Everything except Anthropic speaks an
 * OpenAI-compatible endpoint; Ollama needs no key.
 */
export type ProviderId =
  | "anthropic" | "openai" | "google" | "xai" | "deepseek"
  | "mistral" | "groq" | "ollama" | "openai-compatible";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  xai: "xAI Grok",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible",
};

export const PROVIDER_DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  google: "gemini-2.5-pro",
  xai: "grok-4",
  deepseek: "deepseek-chat",
  mistral: "mistral-large-latest",
  groq: "llama-3.3-70b-versatile",
  ollama: "llama3.1",
  "openai-compatible": "gpt-4o-mini",
};

export const PROVIDER_DEFAULT_BASE_URLS: Partial<Record<ProviderId, string>> = {
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  apiKey: "",
  baseUrl: "",
  maxIterations: 40,
  currency: "USD",
};

/** Running cost accounting, streamed with each model turn. */
export interface CostInfo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Total cost formatted in the user's currency. */
  formatted: string;
  /** Unpriced models report unknown rather than zero. */
  unpriced: boolean;
}

// ---------- Terminal ----------

export interface TerminalInfo {
  id: string;
  cwd: string;
}

// ---------- Git ----------

export interface GitInfo {
  isRepo: boolean;
  branch: string;
  dirtyCount: number;
}

// ---------- Workspace search ----------

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  truncated: boolean;
  hits: SearchHit[];
}

// ---------- Sessions ----------

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface SessionData {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

// ---------- Diffs / revert ----------

export interface DiffLine {
  kind: "context" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface FileDiff {
  path: string;
  isNew: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
}

// ---------- Edits overview ----------

export interface EditSummary {
  path: string;
  added: number;
  removed: number;
}

// ---------- IPC channel names ----------

export const IPC = {
  // workspace / fs
  PickWorkspace: "fs:pick-workspace",
  GetWorkspace: "fs:get-workspace",
  SetWorkspace: "fs:set-workspace",
  ListDirTree: "fs:list-tree",
  ReadFile: "fs:read-file",
  WriteFile: "fs:write-file",

  // settings
  GetSettings: "settings:get",
  SaveSettings: "settings:save",

  // agent
  AgentSend: "agent:send",
  AgentCancel: "agent:cancel",
  AgentEvent: "agent:event",

  // git
  GetGitInfo: "git:get-info",

  // search
  WorkspaceSearch: "search:workspace",

  // sessions
  SessionList: "session:list",
  SessionLoad: "session:load",
  SessionSave: "session:save",
  SessionDelete: "session:delete",
  SessionRename: "session:rename",

  // diffs / revert
  DiffFile: "diff:file",
  RevertFile: "diff:revert",
  ListEdits: "diff:list-edits",

  // watcher
  WatchStart: "watch:start",
  WatchStop: "watch:stop",
  WatchEvent: "watch:event",

  // terminal
  TerminalCreate: "term:create",
  TerminalWrite: "term:write",
  TerminalResize: "term:resize",
  TerminalData: "term:data",
  TerminalExit: "term:exit",
} as const;

// ---------- Agent event stream (main -> renderer) ----------

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "message-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | {
      type: "tool-start";
      id: string;
      toolCallId: string;
      name: string;
      args: string;
    }
  | { type: "tool-result"; toolCallId: string; result: string; isError: boolean }
  | { type: "message-end"; id: string }
  | { type: "cost"; cost: CostInfo }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ArchymedesApi {
  // fs
  pickWorkspace(): Promise<string | null>;
  getWorkspace(): Promise<string | null>;
  setWorkspace(path: string): Promise<void>;
  listDirTree(path: string): Promise<FileNode[]>;
  readFile(path: string): Promise<FileEntry>;
  writeFile(path: string, content: string): Promise<void>;

  // settings
  getSettings(): Promise<ProviderSettings>;
  saveSettings(settings: ProviderSettings): Promise<void>;

  // agent
  sendAgentMessage(history: ChatMessage[], sessionId?: string): Promise<void>;
  cancelAgent(): void;
  onAgentEvent(handler: (event: AgentEvent) => void): () => void;

  // git
  getGitInfo(): Promise<GitInfo>;

  // search
  workspaceSearch(query: string): Promise<SearchResult>;

  // sessions
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<SessionData | null>;
  saveSession(session: SessionData): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;

  // diffs / revert
  diffFile(path: string): Promise<FileDiff | null>;
  revertFile(path: string): Promise<void>;
  listEdits(): Promise<EditSummary[]>;

  // watcher
  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;
  onWatchEvent(handler: (event: { changed: boolean }) => void): () => void;

  // terminal
  createTerminal(cwd?: string): Promise<TerminalInfo>;
  terminalWrite(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  onTerminalData(handler: (id: string, data: string) => void): () => void;
  onTerminalExit(handler: (id: string, code: number) => void): () => void;
}
