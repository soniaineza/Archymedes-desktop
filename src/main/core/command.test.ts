import { describe, expect, it } from "vitest";
import {
  hasShellSyntax,
  isFindDelete,
  isRecursiveForceRemoval,
  sanitizeCommandEnvironment,
  tokenizeCommand,
} from "./command";

describe("tokenizeCommand", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommand("npm run build")).toEqual(["npm", "run", "build"]);
  });

  it("respects single and double quotes", () => {
    expect(tokenizeCommand(`echo "hello world" 'a b'`)).toEqual(["echo", "hello world", "a b"]);
  });

  it("handles backslash escapes on non-Windows", () => {
    expect(tokenizeCommand("echo a\\ b", "linux")).toEqual(["echo", "a b"]);
  });

  it("treats backslash as a literal path separator on Windows", () => {
    expect(tokenizeCommand("dir C:\\Users", "win32")).toEqual(["dir", "C:\\Users"]);
  });

  it("throws on an unbalanced quote", () => {
    expect(() => tokenizeCommand(`echo "unterminated`)).toThrow();
  });

  it("throws on an empty command", () => {
    expect(() => tokenizeCommand("   ")).toThrow();
  });
});

describe("hasShellSyntax", () => {
  it("detects pipes, redirects, and command chaining", () => {
    expect(hasShellSyntax("ls | grep foo")).toBe(true);
    expect(hasShellSyntax("cmd1 && cmd2")).toBe(true);
    expect(hasShellSyntax("echo a > out.txt")).toBe(true);
    expect(hasShellSyntax("echo $(pwd)")).toBe(true);
  });

  it("ignores metacharacters inside quotes", () => {
    expect(hasShellSyntax(`echo "a | b"`)).toBe(false);
  });

  it("is false for a plain argv command", () => {
    expect(hasShellSyntax("npm test")).toBe(false);
  });
});

describe("isRecursiveForceRemoval", () => {
  it("catches -rf in any order or combined form", () => {
    expect(isRecursiveForceRemoval("rm -rf node_modules")).toBe(true);
    expect(isRecursiveForceRemoval("rm -fr node_modules")).toBe(true);
    expect(isRecursiveForceRemoval("rm --recursive --force node_modules")).toBe(true);
    expect(isRecursiveForceRemoval("sudo rm -rf /tmp/x")).toBe(true);
  });

  it("allows rm without both flags", () => {
    expect(isRecursiveForceRemoval("rm -r node_modules")).toBe(false);
    expect(isRecursiveForceRemoval("rm file.txt")).toBe(false);
  });

  it("does not false-positive on unrelated commands", () => {
    expect(isRecursiveForceRemoval("grep -rf pattern .")).toBe(false);
  });
});

describe("isFindDelete", () => {
  it("catches find -delete", () => {
    expect(isFindDelete("find . -name '*.tmp' -delete")).toBe(true);
  });

  it("allows find without -delete", () => {
    expect(isFindDelete("find . -name '*.tmp'")).toBe(false);
  });
});

describe("sanitizeCommandEnvironment", () => {
  it("strips known credential env vars", () => {
    const sanitized = sanitizeCommandEnvironment({ ANTHROPIC_API_KEY: "sk-x", PATH: "/usr/bin" });
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.PATH).toBe("/usr/bin");
  });

  it("in strict mode also strips anything credential-shaped", () => {
    const sanitized = sanitizeCommandEnvironment(
      { MY_CUSTOM_SECRET: "x", SOME_TOKEN: "y", PATH: "/usr/bin" },
      { strict: true },
    );
    expect(sanitized.MY_CUSTOM_SECRET).toBeUndefined();
    expect(sanitized.SOME_TOKEN).toBeUndefined();
    expect(sanitized.PATH).toBe("/usr/bin");
  });

  it("without strict mode leaves credential-shaped-but-unlisted vars alone", () => {
    const sanitized = sanitizeCommandEnvironment({ MY_CUSTOM_SECRET: "x" });
    expect(sanitized.MY_CUSTOM_SECRET).toBe("x");
  });
});
