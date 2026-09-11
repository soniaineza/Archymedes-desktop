import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSession, loadSession, saveSession, sessionsDir } from "./sessions";

let userData: string;

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), "arch-sessions-"));
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe("saveSession", () => {
  it("round-trips a session by id", async () => {
    const session = { id: "abc-123", title: "t", createdAt: 1, updatedAt: 1, messages: [] };
    await saveSession(userData, session);
    expect(await loadSession(userData, "abc-123")).toEqual(session);
  });

  it("rejects an id that would escape the sessions directory", async () => {
    const evil = { id: "../../evil", title: "t", createdAt: 1, updatedAt: 1, messages: [] };
    await expect(saveSession(userData, evil)).rejects.toThrow();
    // Nothing was written outside the sessions dir.
    await expect(fs.readFile(path.join(userData, "..", "evil.json"), "utf8")).rejects.toThrow();
  });

  it("rejects an id with a path separator", async () => {
    const evil = { id: "sub/dir", title: "t", createdAt: 1, updatedAt: 1, messages: [] };
    await expect(saveSession(userData, evil)).rejects.toThrow();
  });
});

describe("loadSession / deleteSession id safety", () => {
  it("returns null for a traversal id instead of reading outside the sessions dir", async () => {
    await fs.mkdir(sessionsDir(userData), { recursive: true });
    expect(await loadSession(userData, "../outside")).toBeNull();
  });

  it("no-ops deleteSession for a traversal id", async () => {
    await expect(deleteSession(userData, "../outside")).resolves.toBeUndefined();
  });
});
