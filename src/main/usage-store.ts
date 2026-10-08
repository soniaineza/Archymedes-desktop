import fs from "node:fs/promises";
import path from "node:path";
import type { DailyUsage, FreeAllowance } from "../shared/types";

/**
 * A local daily token counter, so the user can see how fast a day's free allowance goes. Days are
 * keyed by UTC date (the free gateway's allowance resets at UTC midnight), every model request adds
 * its input + output tokens, and the last allowance the gateway reported is kept beside it.
 * Persisted under userData; a missing or corrupt file starts from zero rather than failing a run.
 */

export type DailyCount = Omit<DailyUsage, "provider">;

interface UsageFile {
  /** UTC date → tokens used that day. */
  days: Record<string, number>;
  allowance?: FreeAllowance;
}

/** Days of history kept on disk; older ones are pruned on each write. */
const KEEP_DAYS = 31;

export function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function usageFile(userDataPath: string): string {
  return path.join(userDataPath, "usage", "daily-tokens.json");
}

function parse(text: string): UsageFile {
  const raw = JSON.parse(text) as { days?: unknown; allowance?: unknown };
  const days: Record<string, number> = {};
  if (raw.days && typeof raw.days === "object") {
    for (const [date, value] of Object.entries(raw.days as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof value === "number" && Number.isFinite(value) && value >= 0) days[date] = value;
    }
  }
  const a = raw.allowance as Partial<FreeAllowance> | undefined;
  const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const allowance =
    a && (count(a.remainingTokens) || count(a.remainingRequests))
      ? {
          ...(count(a.remainingTokens) ? { remainingTokens: a.remainingTokens } : {}),
          ...(count(a.remainingRequests) ? { remainingRequests: a.remainingRequests } : {}),
          ...(typeof a.resetUtc === "string" ? { resetUtc: a.resetUtc } : {}),
          ...(typeof a.warning === "string" ? { warning: a.warning } : {}),
        }
      : undefined;
  return { days, ...(allowance ? { allowance } : {}) };
}

export class DailyUsageStore {
  private loaded: Promise<UsageFile> | null = null;
  /** Writes run one after another, so concurrent records never lose an increment. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly userDataPath: string,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<UsageFile> {
    this.loaded ??= fs
      .readFile(usageFile(this.userDataPath), "utf8")
      .then(parse)
      .catch((): UsageFile => ({ days: {} }));
    return this.loaded;
  }

  /** An allowance past its reset time says nothing about today. */
  private current(state: UsageFile): DailyCount {
    const now = this.now();
    const date = utcDate(now);
    const allowance = state.allowance;
    const reset = allowance?.resetUtc ? Date.parse(allowance.resetUtc) : NaN;
    const fresh = allowance && !(Number.isFinite(reset) && reset <= now);
    return { date, tokens: state.days[date] ?? 0, ...(fresh ? { allowance } : {}) };
  }

  async snapshot(): Promise<DailyCount> {
    await this.queue.catch(() => undefined);
    return this.current(await this.load());
  }

  /** Adds one request's tokens to today and, when the gateway reported one, replaces the allowance. */
  record(tokens: number, allowance?: FreeAllowance): Promise<DailyCount> {
    const next = this.queue.catch(() => undefined).then(async () => {
      const state = await this.load();
      const date = utcDate(this.now());
      if (tokens > 0) state.days[date] = (state.days[date] ?? 0) + Math.round(tokens);
      if (allowance) state.allowance = allowance;
      for (const day of Object.keys(state.days).sort().slice(0, -KEEP_DAYS)) delete state.days[day];
      await this.write(state);
      return this.current(state);
    });
    this.queue = next;
    return next;
  }

  private async write(state: UsageFile): Promise<void> {
    const file = usageFile(this.userDataPath);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Write-then-rename so a crash mid-write can't leave a truncated file.
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(temp, file);
    } catch {
      // The in-memory count stays right for this session; a meter is not worth failing a run over.
    }
  }
}
