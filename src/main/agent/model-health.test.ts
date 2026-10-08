import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_HALF_LIFE_MS, healthScore, ModelHealthStore } from "./model-health";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "archy-health-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const models = (...ids: string[]) => ids.map((id) => ({ id }));

describe("ModelHealthStore", () => {
  it("puts models that answered first, keeps the given order otherwise, and never drops one", async () => {
    const store = new ModelHealthStore(undefined, () => 1_000);
    await store.recordFailure("a", "HTTP 404");
    await store.recordFailure("a", "HTTP 404");
    await store.recordSuccess("c");
    const ranked = await store.rank(models("a", "b", "c", "d"));
    expect(ranked.map((m) => m.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("forgets with a seven-day half-life, so a failed model gets another chance", () => {
    const now = Date.parse("2026-10-08T00:00:00Z");
    const record = { success: 0, failure: 4, updatedAt: now };
    expect(healthScore(record, now)).toBeCloseTo(1 / 6);
    expect(healthScore(record, now + HEALTH_HALF_LIFE_MS)).toBeCloseTo(1 / 4);
    expect(healthScore(record, now + 10 * HEALTH_HALF_LIFE_MS)).toBeCloseTo(0.5, 2);
    expect(healthScore(undefined, now)).toBe(0.5);
  });

  it("persists counts and the last error, and survives a corrupt file", async () => {
    const file = path.join(dir, "health.json");
    const store = new ModelHealthStore(file, () => 5_000);
    await store.recordFailure("x/model:free", "HTTP 429");
    await store.recordSuccess("x/model:free");
    const reopened = new ModelHealthStore(file, () => 5_000);
    expect((await reopened.snapshot())["x/model:free"]).toEqual({
      success: 1,
      failure: 1,
      updatedAt: 5_000,
      lastError: "HTTP 429",
    });

    await fs.writeFile(file, "{broken");
    const fresh = new ModelHealthStore(file, () => 5_000);
    expect(await fresh.snapshot()).toEqual({});
    expect((await fresh.rank(models("a", "b"))).map((m) => m.id)).toEqual(["a", "b"]);
  });
});
