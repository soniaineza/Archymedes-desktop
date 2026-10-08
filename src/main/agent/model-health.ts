import fs from "node:fs/promises";
import path from "node:path";

/**
 * How well each free model has worked on this computer, so free mode tries the ones that answered
 * first. Counts decay with a seven-day half-life, so a model that failed last week gets a fair
 * chance again; nothing is ever excluded for good, only ordered. Persisted under userData; a missing
 * or corrupt file just means no history.
 */

export const HEALTH_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** Records older than this many half-lives weigh almost nothing and are dropped on write. */
const FORGET_AFTER_MS = 6 * HEALTH_HALF_LIFE_MS;
const MAX_MODELS = 200;
const MAX_ERROR_CHARS = 200;

export interface ModelHealthRecord {
  /** Decayed success count as of `updatedAt`. */
  success: number;
  /** Decayed failure count as of `updatedAt`. */
  failure: number;
  updatedAt: number;
  lastError?: string;
}

type HealthFile = Record<string, ModelHealthRecord>;

function decayed(record: ModelHealthRecord, now: number): { success: number; failure: number } {
  const factor = Math.pow(0.5, Math.max(0, now - record.updatedAt) / HEALTH_HALF_LIFE_MS);
  return { success: record.success * factor, failure: record.failure * factor };
}

/** 0..1, with 0.5 for a model never tried (Laplace smoothing keeps one failure from sinking a model). */
export function healthScore(record: ModelHealthRecord | undefined, now: number): number {
  if (!record) return 0.5;
  const { success, failure } = decayed(record, now);
  return (success + 1) / (success + failure + 2);
}

function parse(text: string): HealthFile {
  const raw = JSON.parse(text) as unknown;
  const out: HealthFile = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const row = value as Partial<ModelHealthRecord> | null;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
    if (!row || typeof id !== "string" || id.length > 200 || !ok(row.success) || !ok(row.failure) || !ok(row.updatedAt)) continue;
    out[id] = {
      success: row.success,
      failure: row.failure,
      updatedAt: row.updatedAt,
      ...(typeof row.lastError === "string" ? { lastError: row.lastError.slice(0, MAX_ERROR_CHARS) } : {}),
    };
  }
  return out;
}

export class ModelHealthStore {
  private state: HealthFile | null = null;
  private loading: Promise<HealthFile> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    /** The file, or a resolver for it; `undefined` keeps the history in memory only. */
    private readonly file: string | (() => Promise<string | undefined>) | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private async target(): Promise<string | undefined> {
    return typeof this.file === "function" ? await this.file() : this.file;
  }

  async load(): Promise<HealthFile> {
    if (this.state) return this.state;
    this.loading ??= this.target()
      .then((file) => (file ? fs.readFile(file, "utf8").then(parse) : {}))
      .catch((): HealthFile => ({}));
    this.state = await this.loading;
    return this.state;
  }

  /** Orders ids healthiest first; ties (scores within 0.05) keep the incoming order. Never drops one. */
  async rank<T extends { id: string }>(items: readonly T[]): Promise<T[]> {
    const state = await this.load();
    const now = this.now();
    const bucket = (id: string) => Math.round(healthScore(state[id], now) * 10);
    return items
      .map((item, index) => ({ item, index, bucket: bucket(item.id) }))
      .sort((a, b) => b.bucket - a.bucket || a.index - b.index)
      .map(({ item }) => item);
  }

  async recordSuccess(id: string): Promise<void> {
    await this.record(id, true);
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await this.record(id, false, error);
  }

  async snapshot(): Promise<Readonly<HealthFile>> {
    return { ...(await this.load()) };
  }

  private async record(id: string, success: boolean, error?: string): Promise<void> {
    const state = await this.load();
    const now = this.now();
    const previous = state[id];
    const base = previous ? decayed(previous, now) : { success: 0, failure: 0 };
    state[id] = {
      success: base.success + (success ? 1 : 0),
      failure: base.failure + (success ? 0 : 1),
      updatedAt: now,
      ...(success ? {} : { lastError: (error ?? "failed").slice(0, MAX_ERROR_CHARS) }),
      ...(success && previous?.lastError ? { lastError: previous.lastError } : {}),
    };
    this.prune(state, now);
    await this.persist(state);
  }

  private prune(state: HealthFile, now: number): void {
    for (const [id, record] of Object.entries(state)) if (now - record.updatedAt > FORGET_AFTER_MS) delete state[id];
    const ids = Object.keys(state);
    if (ids.length <= MAX_MODELS) return;
    ids.sort((a, b) => state[a].updatedAt - state[b].updatedAt);
    for (const id of ids.slice(0, ids.length - MAX_MODELS)) delete state[id];
  }

  private persist(state: HealthFile): Promise<void> {
    const next = this.writing.catch(() => undefined).then(async () => {
      const file = await this.target();
      if (!file) return;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
        await fs.rename(temp, file);
      } catch {
        // Ordering hints are not worth failing a run over.
      }
    });
    this.writing = next;
    return next;
  }
}

/** `<userData>/free-model-health.json`, resolved through Electron when it is available. */
export async function userDataHealthFile(): Promise<string | undefined> {
  try {
    const electron = (await import("electron")) as unknown as { app?: { getPath?(name: string): string } };
    const userData = electron.app?.getPath?.("userData");
    return userData ? path.join(userData, "free-model-health.json") : undefined;
  } catch {
    return undefined;
  }
}
