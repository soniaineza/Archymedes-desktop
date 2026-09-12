import { spawn as ptySpawn, IPty } from "node-pty";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import type { ProviderSettings, TerminalShellChoice } from "../shared/types";

/**
 * Terminal sessions backed by node-pty. One shell per panel; the renderer's
 * xterm.js writes keystrokes through IPC and receives raw output back.
 * The shell is user-selectable in Settings, with safe fallbacks: an
 * unavailable shell must never take the terminal down — it falls back toward
 * the platform default and reports why through a warning string.
 */

export interface TerminalSession {
  id: string;
  pty: IPty;
}

let nextId = 1;

// ---------- Shell resolution ----------

const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

/** Locates bash.exe under a Git for Windows install (registry-free). */
function findGitBash(): string | null {
  for (const candidate of GIT_BASH_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreachable drive etc.; try the next candidate
    }
  }
  return null;
}

/** PowerShell that actually exists on this machine (Core first, then Windows). */
function findPowerShell(): { file: string; args: string[]; label: string } {
  const core = process.env.ProgramFiles
    ? path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")
    : null;
  if (core && existsSync(core)) return { file: core, args: ["-NoLogo"], label: "pwsh" };
  return { file: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" };
}

export interface ResolvedShell {
  file: string;
  args: string[];
  /** Set when the requested shell wasn't available and a fallback was used. */
  warning?: string;
  /** Short display name for the tab badge ("pwsh", "cmd", "Git Bash", "zsh"…). */
  label: string;
}

/**
 * Resolve the user's shell preference to an executable. Anything unavailable
 * falls back toward the platform default rather than failing; the warning
 * string travels to the UI so the user knows what actually launched.
 */
export async function resolveShell(
  choice: TerminalShellChoice | undefined,
  customPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedShell> {
  // Non-Windows platforms: honor a custom path, else the login shell.
  if (platform !== "win32") {
    if (choice === "custom" && customPath?.trim()) {
      const file = customPath.trim();
      try {
        await fs.access(file);
        return { file, args: [], label: path.basename(file) };
      } catch {
        const shell = process.env.SHELL || "/bin/bash";
        return {
          file: shell,
          args: [],
          label: path.basename(shell),
          warning: `Custom shell "${file}" not found — using ${shell}.`,
        };
      }
    }
    const shell = process.env.SHELL || "/bin/bash";
    return { file: shell, args: [], label: path.basename(shell) };
  }

  const fallback = (): ResolvedShell => ({ file: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" });

  switch (choice) {
    case "cmd": {
      const cmd = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
      try {
        await fs.access(cmd);
        return { file: cmd, args: [], label: "cmd" };
      } catch {
        return { ...fallback(), warning: "cmd.exe not found — falling back to PowerShell." };
      }
    }

    case "gitbash": {
      const bash = findGitBash();
      if (bash) return { file: bash, args: ["-i", "-l"], label: "Git Bash" };
      return {
        ...fallback(),
        warning: "Git Bash not found (looked in Program Files) — falling back to PowerShell.",
      };
    }

    case "custom": {
      const file = customPath?.trim() ?? "";
      if (!file) {
        return { ...fallback(), warning: "No custom shell path configured — using PowerShell." };
      }
      try {
        await fs.access(file);
        return { file, args: [], label: path.basename(file) };
      } catch {
        return { ...fallback(), warning: `Custom shell "${file}" not found — falling back to PowerShell.` };
      }
    }

    case "powershell":
    case "default":
    default: {
      // Platform default: PowerShell Core if installed, else Windows PowerShell.
      const ps = findPowerShell();
      return { file: ps.file, args: ps.args, label: ps.label };
    }
  }
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  async create(
    settings: ProviderSettings,
    cwd?: string,
    /** Per-tab override; undefined = use the settings' default shell. */
    shellOverride?: TerminalShellChoice,
  ): Promise<{ id: string; warning?: string; shellLabel?: string }> {
    const choice = shellOverride ?? settings.terminalShell;
    const shell = await resolveShell(choice, settings.terminalShellPath);
    const id = `term-${nextId++}`;
    const pty = ptySpawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: cwd || process.cwd(),
      env: process.env as { [key: string]: string },
    });
    this.sessions.set(id, { id, pty });
    return { id, warning: shell.warning, shellLabel: shell.label };
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

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /** Close one terminal deliberately (the ✕ in the UI), killing its shell. */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      session.pty.kill();
    } catch {
      // already dead
    }
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
