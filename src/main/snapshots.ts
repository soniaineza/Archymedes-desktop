import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EditSummary, FileDiff } from "../shared/types";
import { realPathWithin } from "./core/workspace";
import { computeDiff } from "./diffs";

/**
 * Baselines for agent-edited files, so every agent edit can be diffed and reverted.
 *
 * Layout: userData/snapshots/<hash of workspace>/manifest.json + blobs/<hash of path>.
 * Blob names are opaque; the manifest holds the real paths, so no two paths can
 * collide. Each workspace has its own directory, so edits never leak between them.
 */

const MANIFEST = "manifest.json";
const DIFF_DISPLAY_LINES = 2000;

interface SnapshotEntry {
  relPath: string;
  blob: string;
  existedBefore: boolean;
  recordedAt: number;
  /** Change counts, valid while the file's size and mtime still match. */
  stats?: { mtimeMs: number; size: number; added: number; removed: number };
}

interface Manifest {
  version: 1;
  entries: Record<string, SnapshotEntry>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function readIfExists(root: string, relPath: string): Promise<string | null> {
  const abs = await realPathWithin(root, relPath);
  try {
    return await fs.readFile(abs, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class SnapshotStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly userDataPath: string) {}

  /** Records a file's content before its first agent edit. Later edits keep that original baseline. */
  recordBefore(root: string, relPath: string): Promise<void> {
    return this.exclusive(async () => {
      const dir = await this.workspaceDir(root);
      const manifest = await this.readManifest(dir);
      if (manifest.entries[relPath]) return;

      const content = await readIfExists(root, relPath);
      const blob = sha256(relPath).slice(0, 32);
      await fs.mkdir(path.join(dir, "blobs"), { recursive: true });
      await fs.writeFile(path.join(dir, "blobs", blob), content ?? "", "utf8");
      manifest.entries[relPath] = { relPath, blob, existedBefore: content !== null, recordedAt: Date.now() };
      await this.writeManifest(dir, manifest);
    });
  }

  async diff(root: string, relPath: string): Promise<FileDiff | null> {
    const dir = await this.workspaceDir(root);
    const entry = (await this.readManifest(dir)).entries[relPath];
    if (!entry) return null;
    const { lines, added, removed } = await this.compare(root, dir, entry);
    return { path: relPath, isNew: !entry.existedBefore, added, removed, lines: lines.slice(0, DIFF_DISPLAY_LINES) };
  }

  /** Restores the baseline — deleting the file if the agent created it — and forgets the snapshot. */
  revert(root: string, relPath: string): Promise<void> {
    return this.exclusive(async () => {
      const dir = await this.workspaceDir(root);
      const manifest = await this.readManifest(dir);
      const entry = manifest.entries[relPath];
      if (!entry) throw new Error(`No saved snapshot for ${relPath}`);

      const abs = await realPathWithin(root, relPath);
      if (entry.existedBefore) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, await fs.readFile(path.join(dir, "blobs", entry.blob), "utf8"), "utf8");
      } else {
        await fs.rm(abs, { force: true });
      }
      await fs.rm(path.join(dir, "blobs", entry.blob), { force: true });
      delete manifest.entries[relPath];
      await this.writeManifest(dir, manifest);
    });
  }

  /** Files the agent changed and that still differ from their baseline, largest change first. */
  listEdits(root: string): Promise<EditSummary[]> {
    return this.exclusive(async () => {
      const dir = await this.workspaceDir(root);
      const manifest = await this.readManifest(dir);
      let stale = false;
      const summaries: EditSummary[] = [];

      for (const entry of Object.values(manifest.entries)) {
        const abs = await realPathWithin(root, entry.relPath).catch(() => null);
        const stat = abs ? await fs.stat(abs).catch(() => null) : null;
        let { stats } = entry;
        if (!stats || !stat || stats.mtimeMs !== stat.mtimeMs || stats.size !== stat.size) {
          const { added, removed } = await this.compare(root, dir, entry);
          stats = { mtimeMs: stat?.mtimeMs ?? -1, size: stat?.size ?? -1, added, removed };
          entry.stats = stats;
          stale = true;
        }
        if (stats.added > 0 || stats.removed > 0) summaries.push({ path: entry.relPath, added: stats.added, removed: stats.removed });
      }

      if (stale) await this.writeManifest(dir, manifest);
      return summaries.sort((a, b) => b.added + b.removed - (a.added + a.removed));
    });
  }

  /** Deletes snapshots for workspaces untouched for longer than `maxAgeMs`, and the pre-manifest store. */
  async prune(maxAgeMs: number, now = Date.now()): Promise<void> {
    await fs.rm(path.join(this.userDataPath, "edits"), { recursive: true, force: true });
    const base = path.join(this.userDataPath, "snapshots");
    const dirs = await fs.readdir(base).catch(() => [] as string[]);
    for (const name of dirs) {
      const stat = await fs.stat(path.join(base, name, MANIFEST)).catch(() => null);
      if (!stat || now - stat.mtimeMs > maxAgeMs) await fs.rm(path.join(base, name), { recursive: true, force: true });
    }
  }

  private async compare(root: string, dir: string, entry: SnapshotEntry) {
    const before = await fs.readFile(path.join(dir, "blobs", entry.blob), "utf8");
    const after = (await readIfExists(root, entry.relPath).catch(() => null)) ?? "";
    const lines = computeDiff(before, after, Number.POSITIVE_INFINITY);
    const added = lines.filter((line) => line.kind === "add").length;
    const removed = lines.filter((line) => line.kind === "del").length;
    return { lines, added, removed };
  }

  private async workspaceDir(root: string): Promise<string> {
    // Key by real path, so opening a workspace through a symlink finds the same snapshots.
    const real = await fs.realpath(root).catch(() => path.resolve(root));
    return path.join(this.userDataPath, "snapshots", sha256(real).slice(0, 16));
  }

  private async readManifest(dir: string): Promise<Manifest> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), "utf8")) as Partial<Manifest>;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed as Manifest;
    } catch {
      // Missing or unreadable manifest: start fresh.
    }
    return { version: 1, entries: {} };
  }

  private async writeManifest(dir: string, manifest: Manifest): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, MANIFEST);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(manifest), "utf8");
    await fs.rename(temp, file);
  }

  /** Serializes manifest read-modify-write cycles so concurrent calls can't lose updates. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
