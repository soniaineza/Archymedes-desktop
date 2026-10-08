import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptLegacySessions, deleteAllSessions, deleteSession, listLegacySessions, listSessions, loadSession, renameSession, saveSession, sessionsDir } from "./sessions";

let userData: string;
let projectA: string;
let projectB: string;

const chat = (id: string, updatedAt = 1) => ({ id, title: id, createdAt: 1, updatedAt, messages: [] });

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), "arch-sessions-"));
  projectA = path.join(userData, "project-a");
  projectB = path.join(userData, "project-b");
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe("saveSession", () => {
  it("round-trips a session by id, stamped with the project it was saved in", async () => {
    const session = chat("abc-123");
    await saveSession(userData, session, projectA);
    expect(await loadSession(userData, "abc-123", projectA)).toEqual({ ...session, workspace: path.resolve(projectA) });
  });

  it("rejects an id that would escape the sessions directory", async () => {
    const evil = chat("../../evil");
    await expect(saveSession(userData, evil, projectA)).rejects.toThrow();
    // Nothing was written outside the sessions dir.
    await expect(fs.readFile(path.join(userData, "..", "evil.json"), "utf8")).rejects.toThrow();
  });

  it("rejects an id with a path separator", async () => {
    await expect(saveSession(userData, chat("sub/dir"), projectA)).rejects.toThrow();
  });
});

describe("loadSession / deleteSession id safety", () => {
  it("returns null for a traversal id instead of reading outside the sessions dir", async () => {
    await fs.mkdir(sessionsDir(userData), { recursive: true });
    expect(await loadSession(userData, "../outside", projectA)).toBeNull();
  });

  it("no-ops deleteSession for a traversal id", async () => {
    await expect(deleteSession(userData, "../outside", projectA)).resolves.toBeUndefined();
  });
});

describe("chats belong to their project", () => {
  it("lists only the open project's chats, newest first", async () => {
    await saveSession(userData, chat("a-old", 1), projectA);
    await saveSession(userData, chat("a-new", 3), projectA);
    await saveSession(userData, chat("b-only", 2), projectB);
    expect((await listSessions(userData, projectA)).map((s) => s.id)).toEqual(["a-new", "a-old"]);
    expect((await listSessions(userData, projectB)).map((s) => s.id)).toEqual(["b-only"]);
  });

  it("treats a differently spelled path to the same folder as the same project", async () => {
    await saveSession(userData, chat("a1"), projectA);
    const respelled = process.platform === "win32" ? `${projectA.toUpperCase()}\\` : `${projectA}/`;
    expect((await listSessions(userData, respelled)).map((s) => s.id)).toEqual(["a1"]);
  });

  it("will not open, rename, delete or overwrite another project's chat", async () => {
    await saveSession(userData, chat("b1"), projectB);
    expect(await loadSession(userData, "b1", projectA)).toBeNull();
    await renameSession(userData, "b1", "hijacked", projectA);
    await deleteSession(userData, "b1", projectA);
    await expect(saveSession(userData, chat("b1"), projectA)).rejects.toThrow("different project");
    expect(await loadSession(userData, "b1", projectB)).toMatchObject({ title: "b1" });
  });

  it("deletes one chat, or all of the open project's chats, leaving other projects alone", async () => {
    await saveSession(userData, chat("a1"), projectA);
    await saveSession(userData, chat("a2"), projectA);
    await saveSession(userData, chat("b1"), projectB);
    await deleteSession(userData, "a1", projectA);
    expect((await listSessions(userData, projectA)).map((s) => s.id)).toEqual(["a2"]);
    expect(await deleteAllSessions(userData, projectA)).toBe(1);
    expect(await listSessions(userData, projectA)).toEqual([]);
    expect((await listSessions(userData, projectB)).map((s) => s.id)).toEqual(["b1"]);
  });

  it("shows chats saved before projects existed only while no folder is open", async () => {
    await fs.mkdir(sessionsDir(userData), { recursive: true });
    await fs.writeFile(path.join(sessionsDir(userData), "legacy.json"), JSON.stringify(chat("legacy")));
    expect(await listSessions(userData, projectA)).toEqual([]);
    expect((await listSessions(userData, null)).map((s) => s.id)).toEqual(["legacy"]);
  });
});

describe("legacy chats (saved before chats were linked to a project)", () => {
  /** A chat as an older build stored it: no workspace field. */
  async function writeLegacy(id: string, updatedAt = 1): Promise<void> {
    await fs.mkdir(sessionsDir(userData), { recursive: true });
    await fs.writeFile(path.join(sessionsDir(userData), `${id}.json`), JSON.stringify(chat(id, updatedAt)), "utf8");
  }

  it("reports unlinked chats only while a folder is open, newest first", async () => {
    await writeLegacy("old-1", 1);
    await writeLegacy("old-2", 5);
    await saveSession(userData, chat("a-1"), projectA);
    expect(await listLegacySessions(userData, projectA)).toEqual({ count: 2, ids: ["old-2", "old-1"] });
    expect(await listLegacySessions(userData, null)).toEqual({ count: 0, ids: [] });
  });

  it("moves all unlinked chats into the open project, and never touches another project's chats", async () => {
    await writeLegacy("old-1");
    await writeLegacy("old-2");
    await saveSession(userData, chat("b-1"), projectB);
    expect(await adoptLegacySessions(userData, "all", projectA)).toBe(2);
    expect((await listSessions(userData, projectA)).map((s) => s.id).sort()).toEqual(["old-1", "old-2"]);
    expect((await listSessions(userData, projectB)).map((s) => s.id)).toEqual(["b-1"]);
    expect(await listSessions(userData, null)).toEqual([]);
    expect(await listLegacySessions(userData, projectA)).toEqual({ count: 0, ids: [] });
  });

  it("moves only the chats named, and ignores ids that belong to a project", async () => {
    await writeLegacy("old-1");
    await writeLegacy("old-2");
    await saveSession(userData, chat("b-1"), projectB);
    expect(await adoptLegacySessions(userData, ["old-1", "b-1", "../evil"], projectA)).toBe(1);
    expect((await listSessions(userData, projectA)).map((s) => s.id)).toEqual(["old-1"]);
    expect(await loadSession(userData, "b-1", projectB)).toMatchObject({ workspace: path.resolve(projectB) });
    expect((await listLegacySessions(userData, projectA)).ids).toEqual(["old-2"]);
  });

  it("does nothing without an open folder", async () => {
    await writeLegacy("old-1");
    expect(await adoptLegacySessions(userData, "all", null)).toBe(0);
    expect((await listSessions(userData, null)).map((s) => s.id)).toEqual(["old-1"]);
  });
});
