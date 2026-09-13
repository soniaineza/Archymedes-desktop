import { spawn as ptySpawn, IPty } from "node-pty";

/**
 * Terminal sessions backed by node-pty. One shell per panel; the renderer's
 * xterm.js writes keystrokes through IPC and receives raw output back.
 */

export interface TerminalSession {
  id: string;
  cwd: string;
  pty: IPty;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private nextId = 1;

  create(cwd?: string): TerminalSession {
    const id = `term-${this.nextId++}`;
    const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";
    const resolvedCwd = cwd || process.cwd();
    const pty = ptySpawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env: process.env as { [key: string]: string },
    });
    const session: TerminalSession = { id, cwd: resolvedCwd, pty };
    this.sessions.set(id, session);
    return session;
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
