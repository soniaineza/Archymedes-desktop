import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supportsSymlinks } from "../../test-support/symlinks";
import {
  WorkspaceViolation,
  editTextFile,
  globToRegExp,
  grepWorkspace,
  readTextFile,
  realPathWithin,
  writeTextFile,
} from "./workspace";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "arch-ws-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "arch-outside-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("realPathWithin", () => {
  it("accepts paths inside a root that is itself reached through a symlink", async (ctx) => {
    if (!(await supportsSymlinks())) return ctx.skip();
    await fs.writeFile(path.join(root, "a.txt"), "hi");
    const linkedRoot = path.join(outside, "linked-root");
    await fs.symlink(root, linkedRoot);
    await expect(realPathWithin(linkedRoot, "a.txt")).resolves.toBe(await fs.realpath(path.join(root, "a.txt")));
  });

  it("refuses a not-yet-existing path whose existing ancestor escapes through a symlink", async (ctx) => {
    if (!(await supportsSymlinks())) return ctx.skip();
    await fs.symlink(outside, path.join(root, "out-link"));
    await expect(realPathWithin(root, "out-link/new/deep/evil.txt")).rejects.toThrow(WorkspaceViolation);
  });

  it("allows a not-yet-existing path under a real directory", async () => {
    await expect(realPathWithin(root, "new/deep/file.txt")).resolves.toBe(path.join(root, "new/deep/file.txt"));
  });

  it("does not mistake a name that starts with two dots for an escape", async () => {
    await expect(realPathWithin(root, "..hidden")).resolves.toBe(path.join(root, "..hidden"));
  });

  it("resolves a plain relative path inside the root", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hi");
    const resolved = await realPathWithin(root, "a.txt");
    expect(resolved).toBe(path.join(root, "a.txt"));
  });

  it("refuses a lexical .. escape", async () => {
    await expect(realPathWithin(root, "../outside.txt")).rejects.toThrow(WorkspaceViolation);
  });

  it("refuses a symlink that points outside the root", async (ctx) => {
    if (!(await supportsSymlinks())) return ctx.skip();
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await expect(realPathWithin(root, "link.txt")).rejects.toThrow(WorkspaceViolation);
  });

  it("allows a symlink that points to another location inside the root", async (ctx) => {
    if (!(await supportsSymlinks())) return ctx.skip();
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "real.txt"), "hi");
    await fs.symlink(path.join(root, "sub", "real.txt"), path.join(root, "link.txt"));
    const resolved = await realPathWithin(root, "link.txt");
    expect(resolved).toBe(path.join(root, "sub", "real.txt"));
  });
});

describe("readTextFile / writeTextFile / editTextFile", () => {
  it("round-trips a write then a read", async () => {
    await writeTextFile(root, "hello.txt", "line1\nline2\n");
    const result = await readTextFile(root, "hello.txt");
    expect(result.content).toBe("line1\nline2\n");
  });

  it("refuses to write through a symlink that escapes the root", async (ctx) => {
    if (!(await supportsSymlinks())) return ctx.skip();
    await fs.symlink(outside, path.join(root, "out-link"));
    await expect(writeTextFile(root, "out-link/evil.txt", "pwned")).rejects.toThrow(WorkspaceViolation);
  });

  it("edit_file requires the exact old text to appear exactly once", async () => {
    await writeTextFile(root, "f.txt", "const x = 1;\nconst x = 1;\n");
    await expect(editTextFile(root, "f.txt", "const x = 1;", "const x = 2;")).rejects.toThrow(
      WorkspaceViolation,
    );
  });

  it("edit_file replaceAll replaces every occurrence", async () => {
    await writeTextFile(root, "f.txt", "a\na\na\n");
    const result = await editTextFile(root, "f.txt", "a", "b", { replaceAll: true });
    expect(result.replacements).toBe(3);
    expect((await readTextFile(root, "f.txt")).content).toBe("b\nb\nb\n");
  });

  it("edit_file rejects a no-op replacement", async () => {
    await writeTextFile(root, "f.txt", "same\n");
    await expect(editTextFile(root, "f.txt", "same", "same")).rejects.toThrow(WorkspaceViolation);
  });
});

describe("globToRegExp", () => {
  it("matches ** across directories", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("other/c.ts")).toBe(false);
  });

  it("matches brace alternatives", () => {
    const re = globToRegExp("**/*.{js,ts}");
    expect(re.test("a.js")).toBe(true);
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("a.py")).toBe(false);
  });

  it("matches single-char wildcards", () => {
    expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
    expect(globToRegExp("a?.txt").test("abc.txt")).toBe(false);
  });
});

describe("grepWorkspace", () => {
  it("finds literal matches across files", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hello world\nfoo\n");
    await fs.writeFile(path.join(root, "b.txt"), "another hello\n");
    const matches = await grepWorkspace(root, "hello");
    expect(matches.map((m) => m.path).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("supports include globs and regex mode", async () => {
    await fs.writeFile(path.join(root, "a.ts"), "const foo = 1;\n");
    await fs.writeFile(path.join(root, "a.md"), "const foo = 1;\n");
    const matches = await grepWorkspace(root, "const \\w+", { include: "*.ts", regex: true });
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("a.ts");
  });
});
