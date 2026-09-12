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
  /** Typed while the agent is busy; never sent to the model in that state. */
  queued?: boolean;
}

export type AgentStatus =
  | "idle"
  | "thinking"
  | "calling-tool"
  | "awaiting-model"
  | "error";

/** Which shell the integrated terminal spawns. */
export type TerminalShellChoice = "default" | "powershell" | "cmd" | "gitbash" | "custom";

export const TERMINAL_SHELL_LABELS: Record<TerminalShellChoice, string> = {
  default: "System default",
  powershell: "PowerShell",
  cmd: "Command Prompt (cmd)",
  gitbash: "Git Bash",
  custom: "Custom path…",
};

export const TERMINAL_SHELL_CHOICES: readonly TerminalShellChoice[] = [
  "default", "powershell", "cmd", "gitbash", "custom",
];

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
  /** Shell for the integrated terminal; "default" = platform default. */
  terminalShell: TerminalShellChoice;
  /** Executable path used when terminalShell is "custom". */
  terminalShellPath: string;
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
  terminalShell: "default",
  terminalShellPath: "",
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
  /** Latest turn's input size — approximates current context usage. */
  contextTokens?: number;
  /** Model's context window; undefined when the model is unknown. */
  contextLimit?: number;
}

// ---------- Terminal ----------

export interface TerminalInfo {
  id: string;
  cwd: string;
  /** Set when the requested shell wasn't available and a fallback was used. */
  warning?: string;
  /** Short display name of the shell that actually launched ("pwsh", "Git Bash"…). */
  shellLabel?: string;
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

/** A code symbol (function/class/…) found by workspace symbol search. */
export interface SymbolHit {
  path: string;
  line: number;
  name: string;
  kind: SymbolKind;
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "impl";

export interface SearchResult {
  truncated: boolean;
  hits: SearchHit[];
  /** Lowercased query matched case-insensitively (the historical default). */
  caseSensitive?: boolean;
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
  WorkspaceSymbols: "search:symbols",

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
  TerminalKill: "term:kill",
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
  workspaceSearch(query: string, caseSensitive?: boolean): Promise<SearchResult>;
  workspaceSymbols(query: string): Promise<{ hits: SymbolHit[]; truncated: boolean }>;

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
  /**
   * Create a terminal. `shell` overrides the global Settings choice for this
   * tab only; undefined = use the configured default.
   */
  createTerminal(cwd?: string, shell?: TerminalShellChoice): Promise<TerminalInfo>;
  killTerminal(id: string): void;
  terminalWrite(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  onTerminalData(handler: (id: string, data: string) => void): () => void;
  onTerminalExit(handler: (id: string, code: number) => void): () => void;
}
