import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyUsageStore, usageFile, utcDate } from "./usage-store";

let userData: string;
beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), "archy-usage-"));
});
afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

const at = (iso: string) => () => Date.parse(iso);

describe("DailyUsageStore", () => {
  it("counts tokens per UTC day and persists them", async () => {
    const store = new DailyUsageStore(userData, at("2026-10-08T23:30:00Z"));
    await Promise.all([store.record(100), store.record(250)]);
    expect(await store.snapshot()).toEqual({ date: "2026-10-08", tokens: 350 });

    const reopened = new DailyUsageStore(userData, at("2026-10-08T23:59:00Z"));
    expect((await reopened.snapshot()).tokens).toBe(350);
    // A new UTC day starts from zero.
    const tomorrow = new DailyUsageStore(userData, at("2026-10-09T00:01:00Z"));
    expect(await tomorrow.snapshot()).toEqual({ date: "2026-10-09", tokens: 0 });
  });

  it("keeps the gateway's latest allowance until its reset time passes", async () => {
    let now = Date.parse("2026-10-08T10:00:00Z");
    const store = new DailyUsageStore(userData, () => now);
    const allowance = { remainingTokens: 900, resetUtc: "2026-10-09T00:00:00.000Z", warning: "80% used" };
    expect(await store.record(100, allowance)).toEqual({ date: "2026-10-08", tokens: 100, allowance });
    expect((await store.record(50)).allowance).toEqual(allowance);
    now = Date.parse("2026-10-09T00:00:01Z");
    expect(await store.snapshot()).toEqual({ date: "2026-10-09", tokens: 0 });
  });

  it("starts from zero when the file is corrupt, and keeps about a month of days", async () => {
    await fs.mkdir(path.dirname(usageFile(userData)), { recursive: true });
    await fs.writeFile(usageFile(userData), "{not json");
    let now = Date.parse("2026-01-01T12:00:00Z");
    const store = new DailyUsageStore(userData, () => now);
    expect((await store.snapshot()).tokens).toBe(0);
    for (let day = 0; day < 40; day++) {
      await store.record(1);
      now += 24 * 60 * 60 * 1000;
    }
    const saved = JSON.parse(await fs.readFile(usageFile(userData), "utf8")) as { days: Record<string, number> };
    expect(Object.keys(saved.days)).toHaveLength(31);
    expect(saved.days[utcDate(now - 24 * 60 * 60 * 1000)]).toBe(1);
  });
  it("keeps a requests-only allowance from a gateway that reports requests left", async () => {
    const store = new DailyUsageStore(userData, at("2026-10-08T10:00:00Z"));
    const allowance = { remainingRequests: 37, resetUtc: "2026-10-09T00:00:00.000Z" };
    await store.record(10, allowance);
    const reopened = new DailyUsageStore(userData, at("2026-10-08T11:00:00Z"));
    expect((await reopened.snapshot()).allowance).toEqual(allowance);
  });
});
