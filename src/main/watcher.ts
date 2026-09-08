import fs from "node:fs";
import path from "node:path";

/**
 * A workspace watcher with debounce. fs.watch is noisy (one event per write
 * can arrive as several), so everything is collapsed into a single "changed"
 * ping per quiet period. The renderer uses it to refresh the tree/editor.
 */

const DEBOUNCE_MS = 600;
const SKIP = new Set(["node_modules", ".git", "dist", "out", "build", "target", ".cache", "release"]);

export class WorkspaceWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private workspace: string | null = null;

  start(workspace: string, onChange: () => void): void {
    this.stop();
    this.workspace = workspace;
    try {
      this.watcher = fs.watch(workspace, { recursive: true }, (_event, filename) => {
        const rel = filename ? path.join(String(filename)) : "";
        const top = rel.split(path.sep)[0];
        if (top && SKIP.has(top)) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(onChange, DEBOUNCE_MS);
      });
    } catch {
      // Some platforms/network drives don't support recursive watch; the
      // manual refresh button still works.
      this.watcher = null;
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.workspace = null;
  }

  get active(): boolean {
    return this.watcher !== null;
  }

  get watchedPath(): string | null {
    return this.workspace;
  }
}
