import { AppError } from "./app-error";
import type { InvokeArgs, InvokeChannel, IpcSendMap, SendChannel } from "./ipc-contract";
import { isProviderId } from "./providers";
import type { ApprovalDecision, ChatMessage, ChatRole, CommandApprovalMode, ProviderSettings, SessionData, TerminalShellChoice, ToolCallInfo } from "./types";
import { isApprovalDecision, isCommandApprovalMode, isTerminalShellChoice } from "./types";

/**
 * Shape checks for everything the renderer sends to the main process. They
 * reject malformed input and strip unknown fields; they do not decide whether
 * a path is allowed — workspace confinement stays in core/workspace.ts.
 */

type Guard<T> = (value: unknown, name: string) => T;

function invalid(name: string, expected: string): never {
  throw new AppError("invalid-argument", `${name} must be ${expected}`);
}

const MAX_PATH = 4096;
const MAX_TEXT = 10_000_000;

const str: Guard<string> = (v, name) => (typeof v === "string" && v.length <= MAX_TEXT ? v : invalid(name, "a string"));

const optionalStr: Guard<string | undefined> = (v, name) => (v === undefined ? undefined : str(v, name));

const nonEmpty: Guard<string> = (v, name) => (str(v, name).trim() ? (v as string) : invalid(name, "a non-empty string"));

const relPath: Guard<string> = (v, name) => {
  const s = str(v, name);
  return s.length <= MAX_PATH && !s.includes("\u0000") ? s : invalid(name, "a valid path");
};

const finite: Guard<number> = (v, name) => (typeof v === "number" && Number.isFinite(v) ? v : invalid(name, "a finite number"));

const int = (min: number, max: number): Guard<number> => (v, name) => {
  const n = finite(v, name);
  return Number.isInteger(n) && n >= min && n <= max ? n : invalid(name, `an integer from ${min} to ${max}`);
};

const bool: Guard<boolean> = (v, name) => (typeof v === "boolean" ? v : invalid(name, "a boolean"));

function record(v: unknown, name: string): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : invalid(name, "an object");
}

function list<T>(guard: Guard<T>, max: number): Guard<T[]> {
  return (v, name) => {
    if (!Array.isArray(v) || v.length > max) return invalid(name, `a list of at most ${max} items`);
    return v.map((item, i) => guard(item, `${name}[${i}]`));
  };
}

const ROLES: ReadonlySet<string> = new Set<ChatRole>(["user", "assistant", "system"]);

const toolCall: Guard<ToolCallInfo> = (v, name) => {
  const o = record(v, name);
  return {
    id: str(o.id, `${name}.id`),
    name: str(o.name, `${name}.name`),
    args: str(o.args, `${name}.args`),
    ...(o.result === undefined ? {} : { result: str(o.result, `${name}.result`) }),
    ...(o.isError === undefined ? {} : { isError: bool(o.isError, `${name}.isError`) }),
  };
};

const chatMessage: Guard<ChatMessage> = (v, name) => {
  const o = record(v, name);
  const role = str(o.role, `${name}.role`);
  if (!ROLES.has(role)) invalid(`${name}.role`, "user, assistant or system");
  return {
    id: str(o.id, `${name}.id`),
    role: role as ChatRole,
    content: str(o.content, `${name}.content`),
    ...(o.toolCalls === undefined ? {} : { toolCalls: list(toolCall, 1000)(o.toolCalls, `${name}.toolCalls`) }),
  };
};

export const chatHistory = list(chatMessage, 10_000);

export const providerSettings: Guard<ProviderSettings> = (v, name) => {
  const o = record(v, name);
  const provider = str(o.provider, `${name}.provider`);
  if (!isProviderId(provider)) invalid(`${name}.provider`, "a known provider");
  const currency = str(o.currency, `${name}.currency`);
  if (!/^[A-Z]{3}$/.test(currency)) invalid(`${name}.currency`, "an ISO 4217 code");
  const exchangeRate = finite(o.exchangeRate, `${name}.exchangeRate`);
  if (exchangeRate < 0) invalid(`${name}.exchangeRate`, "zero or positive");
  return {
    provider: provider as ProviderSettings["provider"],
    model: str(o.model, `${name}.model`),
    apiKey: str(o.apiKey, `${name}.apiKey`),
    baseUrl: str(o.baseUrl, `${name}.baseUrl`),
    maxIterations: int(1, 200)(o.maxIterations, `${name}.maxIterations`),
    currency,
    exchangeRate,
    responseLanguage: str(o.responseLanguage, `${name}.responseLanguage`),
    terminalShell: terminalShellChoice(o.terminalShell, `${name}.terminalShell`),
    terminalShellPath: str(o.terminalShellPath, `${name}.terminalShellPath`),
    // Settings saved before approvals existed have no field; they get the safe default.
    commandApproval: o.commandApproval === undefined ? "ask" : commandApprovalMode(o.commandApproval, `${name}.commandApproval`),
  };
};

const commandApprovalMode: Guard<CommandApprovalMode> = (v, name) => {
  const s = str(v, name);
  return isCommandApprovalMode(s) ? s : invalid(name, "\"ask\" or \"auto\"");
};

const approvalDecision: Guard<ApprovalDecision> = (v, name) => {
  const s = str(v, name);
  return isApprovalDecision(s) ? s : invalid(name, "allow, allow-always or deny");
};

const terminalShellChoice: Guard<TerminalShellChoice> = (v, name) => {
  const s = str(v, name);
  return isTerminalShellChoice(s) ? s : invalid(name, "a known shell choice");
};

export const sessionData: Guard<SessionData> = (v, name) => {
  const o = record(v, name);
  return {
    id: nonEmpty(o.id, `${name}.id`),
    title: str(o.title, `${name}.title`),
    createdAt: finite(o.createdAt, `${name}.createdAt`),
    updatedAt: finite(o.updatedAt, `${name}.updatedAt`),
    messages: chatHistory(o.messages, `${name}.messages`),
  };
};

type ArgsGuard<Args> = (args: unknown[]) => Args;

function none(channel: string): ArgsGuard<[]> {
  return (args) => (args.length === 0 ? [] : invalid(channel, "called without arguments"));
}

export type InvokeGuards = { [K in InvokeChannel]: ArgsGuard<InvokeArgs<K>> };
export type SendGuards = { [K in SendChannel]: ArgsGuard<IpcSendMap[K]> };

/** One guard per channel; the mapped type makes a missing guard a compile error. */
export const INVOKE_GUARDS: InvokeGuards = {
  "fs:pick-workspace": ([title]) => [optionalStr(title, "dialogTitle")],
  "fs:get-workspace": none("fs:get-workspace"),
  "fs:set-workspace": ([path]) => [nonEmpty(path, "path")],
  "fs:list-tree": ([path]) => [path === undefined ? "" : relPath(path, "relPath")],
  "fs:read-file": ([path]) => [relPath(path, "relPath")],
  "fs:write-file": ([path, content]) => [relPath(path, "relPath"), str(content, "content")],

  "settings:get": none("settings:get"),
  "settings:save": ([settings]) => [providerSettings(settings, "settings")],

  "agent:send": ([history]) => [chatHistory(history, "history")],
  "agent:cancel": none("agent:cancel"),
  "agent:approve": ([requestId, decision]) => [nonEmpty(requestId, "requestId"), approvalDecision(decision, "decision")],

  "git:get-info": none("git:get-info"),
  "search:workspace": ([query, caseSensitive]) => [str(query, "query"), caseSensitive === undefined ? false : bool(caseSensitive, "caseSensitive")],
  "symbols:workspace": ([query]) => [str(query, "query")],

  "session:list": none("session:list"),
  "session:load": ([id]) => [nonEmpty(id, "id")],
  "session:save": ([session]) => [sessionData(session, "session")],
  "session:delete": ([id]) => [nonEmpty(id, "id")],
  "session:rename": ([id, title]) => [nonEmpty(id, "id"), str(title, "title")],

  "diff:file": ([path]) => [relPath(path, "relPath")],
  "diff:revert": ([path]) => [relPath(path, "relPath")],
  "diff:list-edits": none("diff:list-edits"),

  "watch:start": none("watch:start"),
  "watch:stop": none("watch:stop"),

  "term:create": ([cwd, shell]) => [optionalStr(cwd, "cwd"), optionalStr(shell, "shell")],
};

export const SEND_GUARDS: SendGuards = {
  "term:write": ([id, data]) => [nonEmpty(id, "id"), str(data, "data")],
  "term:resize": ([id, cols, rows]) => [nonEmpty(id, "id"), int(1, 2000)(cols, "cols"), int(1, 2000)(rows, "rows")],
  "term:kill": ([id]) => [nonEmpty(id, "id")],
};
