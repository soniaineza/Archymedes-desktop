import { spawn as ptySpawn, IPty } from "node-pty";
import fs from "node:fs/promises";
import path from "node:path";
import type { TerminalShellChoice } from "../shared/types";

/**
 * Terminal sessions backed by node-pty. One shell per panel; the renderer's
 * xterm.js writes keystrokes through IPC and receives raw output back.
 * The shell is resolved per tab: an explicit override wins, then the saved
 * setting, then the platform default. An unavailable shell never hard-fails —
 * it falls back and reports a warning the renderer prints into the buffer.
 */

export interface TerminalSession {
  id: string;
  cwd: string;
  pty: IPty;
}

export interface ShellRequest {
  choice: TerminalShellChoice;
  customPath: string;
}

export interface ResolvedShell {
  file: string;
  args: string[];
  label: string;
  warning?: string;
}

const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

async function firstExisting(files: string[]): Promise<string | null> {
  for (const file of files) {
    try {
      await fs.access(file);
      return file;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveShell(request: ShellRequest): Promise<ResolvedShell> {
  const { choice, customPath } = request;

  if (choice === "custom" && customPath.trim()) {
    const file = path.resolve(customPath.trim());
    if (await exists(file)) {
      return { file, args: [], label: path.basename(file) };
    }
    return {
      ...(await defaultShell()),
      warning: `Custom shell not found: ${file}`,
    };
  }

  if (process.platform === "win32") {
    if (choice === "cmd") {
      const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
      if (await exists(comspec)) return { file: comspec, args: [], label: "cmd" };
      return { file: "powershell.exe", args: ["-NoLogo"], label: "PowerShell", warning: "cmd.exe not found — falling back to PowerShell." };
    }
    if (choice === "gitbash") {
      const bash = await firstExisting(GIT_BASH_CANDIDATES);
      if (bash) return { file: bash, args: ["-i", "-l"], label: "Git Bash" };
      return { file: "powershell.exe", args: ["-NoLogo"], label: "PowerShell", warning: "Git Bash not found — falling back to PowerShell." };
    }
    if (choice === "powershell") {
      const pwsh = await firstExisting([
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
      ]);
      if (pwsh) return { file: pwsh, args: ["-NoLogo"], label: "PowerShell 7" };
      return { file: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" };
    }
    return defaultShell();
  }

  // Non-Windows: everything except Git Bash/custom maps to the login shell.
  const login = process.env.SHELL || "/bin/bash";
  if (choice === "custom" || choice === "gitbash") {
    const candidate = choice === "custom" ? path.resolve(customPath.trim()) : "/bin/bash";
    if (customPath.trim() === "" && choice === "custom") return { file: login, args: [], label: path.basename(login) };
    if (await exists(candidate)) return { file: candidate, args: [], label: path.basename(candidate) };
    return { file: login, args: [], label: path.basename(login), warning: `Shell not found: ${candidate}` };
  }
  return { file: login, args: [], label: path.basename(login) };
}

async function defaultShell(): Promise<ResolvedShell> {
  if (process.platform === "win32") {
    const pwsh = await firstExisting([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
    ]);
    if (pwsh) return { file: pwsh, args: ["-NoLogo"], label: "PowerShell 7" };
    return { file: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" };
  }
  const login = process.env.SHELL || "/bin/bash";
  return { file: login, args: [], label: path.basename(login) };
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private nextId = 1;

  async create(cwd?: string, shell?: ShellRequest): Promise<TerminalSession & { shellLabel: string; warning?: string }> {
    const resolved = shell ? await resolveShell(shell) : await defaultShell();
    const id = `term-${this.nextId++}`;
    const resolvedCwd = cwd || process.cwd();
    const pty = ptySpawn(resolved.file, resolved.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env: process.env as { [key: string]: string },
    });
    const session: TerminalSession = { id, cwd: resolvedCwd, pty };
    this.sessions.set(id, session);
    return { ...session, shellLabel: resolved.label, warning: resolved.warning };
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.pty.resize(cols, rows);
    } catch {
      // pty may already be dead; resizing a dead terminal is harmless
    }
  }

  /** Kill one shell (tab closed). The pty's onExit fires afterwards. */
  kill(id: string): void {
    try {
      this.sessions.get(id)?.pty.kill();
    } catch {
      // already dead
    }
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  onExit(id: string): void {
    this.sessions.delete(id);
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.pty.kill();
      } catch {
        // already dead
      }
    }
    this.sessions.clear();
  }
}
