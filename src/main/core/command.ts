/**
 * Port of the CLI's bounded command executor (packages/core/src/cli/command.ts).
 * Direct argv execution when possible, shell only when shell syntax demands it,
 * output capped, process tree killed on timeout/cancel, credentials stripped
 * from the spawned environment.
 */

import { spawn } from "node:child_process";

export type CommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number; strictEnvironment?: boolean; signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Credentials this app holds; a spawned command has no legitimate reason to see them. */
export const ARCHYMEDES_CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "E2B_API_KEY",
  "EXA_API_KEY",
] as const;

const SENSITIVE_SHAPED_ENV_PATTERN = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY)/i;

export type EnvironmentDict = Record<string, string | undefined>;

export function sanitizeCommandEnvironment(
  env: EnvironmentDict = process.env,
  options: { strict?: boolean } = {},
): EnvironmentDict {
  const sanitized: EnvironmentDict = { ...env };
  const blocked = new Set<string>(ARCHYMEDES_CREDENTIAL_ENV_NAMES);
  for (const key of Object.keys(sanitized)) {
    if (blocked.has(key) || (options.strict && SENSITIVE_SHAPED_ENV_PATTERN.test(key))) delete sanitized[key];
  }
  return sanitized;
}

/** Minimal shell-compatible tokenization for the direct-exec fast path. */
export function tokenizeCommand(command: string, platform: NodeJS.Platform = process.platform): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let hasToken = false;

  for (const character of command) {
    if (escaped) { current += character; escaped = false; hasToken = true; continue; }
    // A Windows backslash is a path separator, not a Unix escape.
    if (character === "\\" && quote !== "'" && platform !== "win32") { escaped = true; hasToken = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; hasToken = true; continue; }
    if (/\s/.test(character)) {
      if (hasToken) { tokens.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += character;
    hasToken = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unbalanced quote in command");
  if (hasToken) tokens.push(current);
  if (tokens.length === 0) throw new Error("Command is empty");
  return tokens;
}

function hasFlag(tokens: readonly string[], shortLetter: string, long: string): boolean {
  return tokens.some((token) => {
    if (token === long) return true;
    if (token.startsWith("--") || !/^-[a-zA-Z]+$/.test(token)) return false;
    return token.slice(1).includes(shortLetter);
  });
}

const COMMAND_WRAPPERS = new Set(["sudo"]);

function programIndex(tokens: readonly string[], program: string): number {
  if (tokens[0]?.toLowerCase() === program) return 0;
  if (tokens[0] && COMMAND_WRAPPERS.has(tokens[0].toLowerCase()) && tokens[1]?.toLowerCase() === program) return 1;
  return -1;
}

/** `rm` with both recursive and force, in any order and any spelling. */
export function isRecursiveForceRemoval(command: string): boolean {
  let tokens: string[];
  try { tokens = tokenizeCommand(command); } catch { return false; }
  const rmIndex = programIndex(tokens, "rm");
  if (rmIndex === -1) return false;
  const flags = tokens.slice(rmIndex + 1);
  const recursive = hasFlag(flags, "r", "--recursive") || hasFlag(flags, "R", "--recursive");
  const force = hasFlag(flags, "f", "--force");
  return recursive && force;
}

export function isFindDelete(command: string): boolean {
  let tokens: string[];
  try { tokens = tokenizeCommand(command); } catch { return false; }
  const findIndex = programIndex(tokens, "find");
  if (findIndex === -1) return false;
  return tokens.slice(findIndex + 1).includes("-delete");
}

const SHELL_METACHARACTERS = /[|&;><`$()]|\|\||&&/;

export function hasShellSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (SHELL_METACHARACTERS.test(character)) return true;
  }
  return false;
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Negative pid targets the whole process group (the child was spawned detached).
      try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
    }
  } catch {
    // Already gone.
  }
}

export const runLocalCommand: CommandRunner = async (command, options) => {
  if (options.signal?.aborted) return { exitCode: 130, stdout: "", stderr: "Command cancelled before start." };
  const throughShell = hasShellSyntax(command);
  let program: string;
  let argv: string[];
  try {
    [program, ...argv] = throughShell ? [command] : tokenizeCommand(command);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: error instanceof Error ? error.message : "Invalid command" };
  }

  return new Promise((resolve) => {
    const child = spawn(program, argv, {
      cwd: options.cwd,
      shell: throughShell,
      detached: process.platform !== "win32",
      env: sanitizeCommandEnvironment(process.env, { strict: options.strictEnvironment }) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maximumOutputBytes = 2 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let forcedExitCode: number | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      forcedExitCode = 124;
      stderr += `\nCommand exceeded ${options.timeoutMs}ms and was killed.`;
      terminate();
    }, options.timeoutMs);
    let abort = () => {};
    let closedCode: number | null | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;

    const terminate = () => {
      terminateProcessTree(child.pid);
      killTimer ??= setTimeout(() => {
        if (!settled && process.platform !== "win32" && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
        }
      }, 500);
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode: forcedExitCode ?? exitCode, stdout, stderr });
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maximumOutputBytes - outputBytes;
      if (remaining > 0) {
        const text = buffer.subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += text;
        else stderr += text;
        outputBytes += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining && forcedExitCode === null) {
        forcedExitCode = 125;
        stderr += `\nCommand exceeded the ${maximumOutputBytes}-byte output limit and was killed.`;
        terminate();
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const finishWhenDrained = () => {
      if (closedCode !== undefined && stdoutEnded && stderrEnded) finish(closedCode ?? 0);
    };
    child.stdout.on("end", () => { stdoutEnded = true; finishWhenDrained(); });
    child.stderr.on("end", () => { stderrEnded = true; finishWhenDrained(); });
    child.on("error", (error) => {
      if (settled) return;
      stderr += error.message;
      finish(127);
    });
    child.on("close", (code) => { closedCode = code; finishWhenDrained(); });

    abort = () => {
      if (settled || forcedExitCode === 130) return;
      forcedExitCode = 130;
      stderr += "\nCommand cancelled and its process tree was terminated.";
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
};

/** A rejected-by-policy command throws instead of running. */
export async function runGuardedCommand(command: string, options: Parameters<CommandRunner>[1]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (isRecursiveForceRemoval(command)) {
    return { exitCode: 2, stdout: "", stderr: "Refused: `rm -rf` is blocked by policy. Delete specific paths instead." };
  }
  if (isFindDelete(command)) {
    return { exitCode: 2, stdout: "", stderr: "Refused: `find -delete` is blocked by policy. Delete specific paths instead." };
  }
  return runLocalCommand(command, options);
}
