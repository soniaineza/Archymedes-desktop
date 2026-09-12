import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "./snapshots";

let tmp: string;
let userData: string;
let root: string;
let store: SnapshotStore;

const file = (relPath: string) => path.join(root, relPath);
const write = async (relPath: string, content: string) => {
  await fs.mkdir(path.dirname(file(relPath)), { recursive: true });
  await fs.writeFile(file(relPath), content);
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "arch-snap-"));
  userData = path.join(tmp, "user-data");
  root = path.join(tmp, "project");
  await Promise.all([fs.mkdir(userData), fs.mkdir(root)]);
  store = new SnapshotStore(userData);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("SnapshotStore", () => {
  it("diffs an edited file against its baseline", async () => {
    await write("a.ts", "one\ntwo\n");
    await store.recordBefore(root, "a.ts");
    await write("a.ts", "one\nTWO\nthree\n");

    const diff = await store.diff(root, "a.ts");
    expect(diff).toMatchObject({ path: "a.ts", isNew: false, added: 2, removed: 1 });
  });

  it("counts repeated identical lines, which a set comparison would miss", async () => {
    await write("list.txt", "item\n");
    await store.recordBefore(root, "list.txt");
    await write("list.txt", "item\nitem\nitem\n");
    expect(await store.diff(root, "list.txt")).toMatchObject({ added: 2, removed: 0 });
  });

  it("keeps paths distinct that an escaped filename would have merged", async () => {
    await write("my file.ts", "a");
    await write("my/file.ts", "b");
    await write("a__b.ts", "c");
    for (const p of ["my file.ts", "my/file.ts", "a__b.ts"]) await store.recordBefore(root, p);
    for (const p of ["my file.ts", "my/file.ts", "a__b.ts"]) await write(p, "changed");

    expect((await store.listEdits(root)).map((e) => e.path).sort()).toEqual(["a__b.ts", "my file.ts", "my/file.ts"]);
    await store.revert(root, "a__b.ts");
    expect(await fs.readFile(file("a__b.ts"), "utf8")).toBe("c");
    expect(await fs.readFile(file("my/file.ts"), "utf8")).toBe("changed");
  });

  it("keeps the original baseline across repeated agent edits", async () => {
    await write("config.json", "original");
    await store.recordBefore(root, "config.json");
    await write("config.json", "first edit");
    await store.recordBefore(root, "config.json");
    await write("config.json", "second edit");

    await store.revert(root, "config.json");
    expect(await fs.readFile(file("config.json"), "utf8")).toBe("original");
  });

  it("marks created files as new and deletes them on revert", async () => {
    await store.recordBefore(root, "src/new.ts");
    await write("src/new.ts", "export {};\n");

    expect(await store.diff(root, "src/new.ts")).toMatchObject({ isNew: true, added: 1 });
    await store.revert(root, "src/new.ts");
    await expect(fs.stat(file("src/new.ts"))).rejects.toThrow();
  });

  it("forgets a snapshot once reverted", async () => {
    await write("a.txt", "x");
    await store.recordBefore(root, "a.txt");
    await write("a.txt", "y");
    await store.revert(root, "a.txt");

    expect(await store.diff(root, "a.txt")).toBeNull();
    await expect(store.revert(root, "a.txt")).rejects.toThrow("No saved snapshot");
  });

  it("omits files that were changed back to their original content", async () => {
    await write("a.txt", "same");
    await store.recordBefore(root, "a.txt");
    await write("a.txt", "different");
    expect(await store.listEdits(root)).toHaveLength(1);
    await write("a.txt", "same");
    expect(await store.listEdits(root)).toEqual([]);
  });

  it("recounts after the file changes again, even when counts were cached", async () => {
    await write("a.txt", "1\n");
    await store.recordBefore(root, "a.txt");
    await write("a.txt", "1\n2\n");
    expect(await store.listEdits(root)).toEqual([{ path: "a.txt", added: 1, removed: 0 }]);
    await write("a.txt", "1\n2\n3\n4\n");
    expect(await store.listEdits(root)).toEqual([{ path: "a.txt", added: 3, removed: 0 }]);
  });

  it("keeps each workspace's edits separate", async () => {
    const other = path.join(tmp, "other");
    await fs.mkdir(other);
    await write("a.txt", "x");
    await store.recordBefore(root, "a.txt");
    await write("a.txt", "y");

    expect(await store.listEdits(other)).toEqual([]);
    expect(await store.diff(other, "a.txt")).toBeNull();
  });

  it("finds the same snapshots when the workspace is opened through a symlink", async () => {
    await write("a.txt", "x");
    await store.recordBefore(root, "a.txt");
    await write("a.txt", "y");
    const linked = path.join(tmp, "linked");
    await fs.symlink(root, linked);
    expect((await store.listEdits(linked)).map((e) => e.path)).toEqual(["a.txt"]);
  });

  it("refuses to snapshot paths outside the workspace", async () => {
    await expect(store.recordBefore(root, "../outside.txt")).rejects.toThrow();
  });

  it("serializes concurrent snapshots without losing any", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    await Promise.all(paths.map((p) => write(p, "before")));
    await Promise.all(paths.map((p) => store.recordBefore(root, p)));
    await Promise.all(paths.map((p) => write(p, "after")));
    expect(await store.listEdits(root)).toHaveLength(12);
  });

  it("prunes stale workspaces and the legacy edits directory", async () => {
    await write("a.txt", "x");
    await store.recordBefore(root, "a.txt");
    await fs.mkdir(path.join(userData, "edits"));

    await store.prune(30 * 86_400_000, Date.now() + 31 * 86_400_000);

    expect(await fs.readdir(path.join(userData, "snapshots"))).toEqual([]);
    await expect(fs.stat(path.join(userData, "edits"))).rejects.toThrow();
  });
});
