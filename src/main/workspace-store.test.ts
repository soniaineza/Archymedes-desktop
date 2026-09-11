import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirTree, readFileEntry, setWorkspacePath, writeFileEntry } from "./workspace-store";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "arch-store-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "arch-store-outside-"));
  setWorkspacePath(root);
});

afterEach(async () => {
  setWorkspacePath(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("workspace-store symlink confinement", () => {
  it("reads a plain file inside the workspace", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hi");
    expect((await readFileEntry("a.txt")).content).toBe("hi");
  });

  it("refuses to read through a symlink pointing outside the workspace", async () => {
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await expect(readFileEntry("link.txt")).rejects.toThrow();
  });

  it("refuses to write through a symlinked directory that escapes the workspace", async () => {
    await fs.symlink(outside, path.join(root, "out-link"));
    await expect(writeFileEntry("out-link/evil.txt", "pwned")).rejects.toThrow();
    await expect(fs.readFile(path.join(outside, "evil.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses to list a symlinked directory that escapes the workspace", async () => {
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(outside, path.join(root, "out-link"));
    await expect(listDirTree("out-link")).rejects.toThrow();
  });
});
