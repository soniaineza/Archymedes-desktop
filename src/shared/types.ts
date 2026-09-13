/**
 * Shared types used by main, preload, and renderer.
 * Kept dependency-free so all three builds can import it.
 */

import type { AppErrorCode, AppErrorParams } from "./app-error";
import { PROVIDER_INFO } from "./providers";
import type { ProviderId } from "./providers";

export type { ProviderId } from "./providers";

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
  /** A message waiting for the current run to finish; UI-only, never sent or saved. */
  queued?: boolean;
}

/** Currency the price catalog publishes in; costs are converted from it. */
export const PRICE_CATALOG_CURRENCY = "USD";

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
  /** ISO 4217 code costs are displayed in. */
  currency: string;
  /** Units of `currency` per 1 unit of the price catalog's currency; 0 = show the catalog currency. */
  exchangeRate: number;
  /** English name of the language the agent replies in; "" = match the user's messages. */
  responseLanguage: string;
  /** Default shell for new terminal tabs. */
  terminalShell: TerminalShellChoice;
  /** Executable path used when terminalShell is "custom". */
  terminalShellPath: string;
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  provider: "anthropic",
  model: PROVIDER_INFO.anthropic.defaultModel,
  apiKey: "",
  baseUrl: "",
  maxIterations: 40,
  currency: "USD",
  exchangeRate: 0,
  responseLanguage: "",
  terminalShell: "default",
  terminalShellPath: "",
};

/** Running cost accounting, streamed with each model turn. */
export interface CostInfo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Prompt tokens of the last model turn, for the context meter. */
  contextTokens?: number;
  /** Model context window from the capabilities table, when known. */
  contextLimit?: number;
  /** Total cost in millionths of one unit of `currency`; the renderer formats it for the user's locale. */
  costMicros: number;
  currency: string;
  /** True when converted from the catalog currency with the user's exchange rate. */
  converted: boolean;
  /** Unpriced models report unknown rather than zero. */
  unpriced: boolean;
}

// ---------- Terminal ----------

export type TerminalShellChoice = "default" | "powershell" | "cmd" | "gitbash" | "custom";
export const TERMINAL_SHELL_CHOICES: readonly TerminalShellChoice[] = ["default", "powershell", "cmd", "gitbash", "custom"];

export function isTerminalShellChoice(value: string): value is TerminalShellChoice {
  return TERMINAL_SHELL_CHOICES.includes(value as TerminalShellChoice);
}

export interface TerminalInfo {
  id: string;
  cwd: string;
  /** Display label of the shell that actually launched, e.g. "PowerShell". */
  shellLabel?: string;
  /** Set when the requested shell was unavailable and a fallback launched. */
  warning?: string;
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
  /** Echo of the requested case sensitivity, so the UI highlight matches. */
  caseSensitive?: boolean;
}

// ---------- Symbols ----------

export type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "struct" | "trait" | "impl";

export interface SymbolHit {
  path: string;
  line: number;
  name: string;
  kind: SymbolKind;
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
  | { type: "error"; message: string; code?: AppErrorCode; params?: AppErrorParams };

export type { ArchymedesApi } from "./ipc-contract";
