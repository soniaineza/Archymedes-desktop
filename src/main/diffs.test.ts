import { describe, expect, it } from "vitest";
import { computeDiff } from "./diffs";

describe("computeDiff", () => {
  it("reports no changes for identical text", () => {
    const lines = computeDiff("a\nb\nc", "a\nb\nc");
    expect(lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("marks appended lines as additions", () => {
    const lines = computeDiff("a\nb", "a\nb\nc");
    expect(lines.at(-1)).toMatchObject({ kind: "add", text: "c" });
  });

  it("marks removed lines as deletions", () => {
    const lines = computeDiff("a\nb\nc", "a\nc");
    expect(lines.some((l) => l.kind === "del" && l.text === "b")).toBe(true);
  });

  it("finds a minimal edit for a single changed line", () => {
    const lines = computeDiff("a\nb\nc", "a\nX\nc");
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "del", "add", "context"]);
  });

  it("caps output at capLines", () => {
    const before = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const after = Array.from({ length: 10 }, (_, i) => `changed${i}`).join("\n");
    const lines = computeDiff(before, after, 5);
    expect(lines).toHaveLength(5);
  });
});
