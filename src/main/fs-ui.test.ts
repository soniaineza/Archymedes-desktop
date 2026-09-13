import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirTree, readFileForEditor, writeFileFromEditor } from "./fs-ui";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "arch-fsui-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "arch-fsui-outside-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("editor file access stays inside the workspace", () => {
  it("reads a plain file inside the workspace", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hi");
    expect(await readFileForEditor(root, "a.txt")).toEqual({ path: "a.txt", content: "hi", truncated: false });
  });

  it("refuses to read through a symlink pointing outside the workspace", async () => {
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await expect(readFileForEditor(root, "link.txt")).rejects.toThrow();
  });

  it("refuses to write through a symlinked directory that escapes the workspace", async () => {
    await fs.symlink(outside, path.join(root, "out-link"));
    await expect(writeFileFromEditor(root, "out-link/evil.txt", "pwned")).rejects.toThrow();
    await expect(fs.readFile(path.join(outside, "evil.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses to create directories outside through a symlinked parent", async () => {
    await fs.symlink(outside, path.join(root, "out-link"));
    await expect(writeFileFromEditor(root, "out-link/a/b/evil.txt", "pwned")).rejects.toThrow();
    await expect(fs.stat(path.join(outside, "a"))).rejects.toThrow();
  });

  it("works when the workspace root itself is opened through a symlink", async () => {
    const linkedRoot = path.join(outside, "linked-root");
    await fs.symlink(root, linkedRoot);
    await fs.writeFile(path.join(root, "a.txt"), "hi");
    expect((await readFileForEditor(linkedRoot, "a.txt")).content).toBe("hi");
    await writeFileFromEditor(linkedRoot, "sub/new.txt", "new");
    expect(await fs.readFile(path.join(root, "sub/new.txt"), "utf8")).toBe("new");
    expect((await listDirTree(linkedRoot)).length).toBeGreaterThan(0);
  });

  it("refuses to list a symlinked directory that escapes the workspace", async () => {
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(outside, path.join(root, "out-link"));
    await expect(listDirTree(root, "out-link")).rejects.toThrow();
  });
});

describe("file tree", () => {
  it("lists directories first, hides dotfiles and ignored directories", async () => {
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "src", "main.ts"), "");
    await fs.writeFile(path.join(root, "README.md"), "");
    await fs.writeFile(path.join(root, ".env"), "SECRET=1");
    await fs.writeFile(path.join(root, ".env.example"), "SECRET=");

    const tree = await listDirTree(root);
    expect(tree.map((n) => n.name)).toEqual(["src", ".env.example", "README.md"]);
    expect(tree[0].children?.map((n) => n.path)).toEqual(["src/main.ts"]);
  });
});

describe("large files", () => {
  it("truncates instead of refusing", async () => {
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(600 * 1024));
    const entry = await readFileForEditor(root, "big.txt");
    expect(entry.truncated).toBe(true);
    expect(entry.content.length).toBe(512 * 1024);
  });
});
