import { describe, expect, it } from "vitest";
import { normalizeJsonish, repairToolArgs } from "./tool-args";

const parsed = (raw: string) => {
  const result = repairToolArgs(raw);
  if (!result.ok) throw new Error(`not repaired: ${raw}`);
  return JSON.parse(result.json) as unknown;
};

describe("repairToolArgs", () => {
  it("passes valid JSON through untouched", () => {
    expect(repairToolArgs('{"path": "a.ts"}')).toEqual({ ok: true, json: '{"path": "a.ts"}', repaired: false });
    expect(repairToolArgs("")).toEqual({ ok: true, json: "{}", repaired: false });
  });

  it("drops trailing commas", () => {
    expect(parsed('{"path": "a.ts", "limit": 5,}')).toEqual({ path: "a.ts", limit: 5 });
    expect(parsed('{"paths": ["a", "b",],}')).toEqual({ paths: ["a", "b"] });
  });

  it("turns single-quoted strings and bare keys into JSON", () => {
    expect(parsed("{'path': 'it\\'s.ts', 'note': 'say \"hi\"'}")).toEqual({ path: "it's.ts", note: 'say "hi"' });
    expect(parsed("{path: 'a.ts', replaceAll: True, offset: None}")).toEqual({ path: "a.ts", replaceAll: true, offset: null });
  });

  it("unwraps code-fenced JSON and JSON surrounded by prose", () => {
    expect(parsed('```json\n{"path": "a.ts"}\n```')).toEqual({ path: "a.ts" });
    expect(parsed('Here are the arguments: {"path": "a.ts"} hope that helps')).toEqual({ path: "a.ts" });
  });

  it("decodes an object sent as a JSON string, and a self-wrapped call", () => {
    expect(parsed(JSON.stringify(JSON.stringify({ path: "a.ts" })))).toEqual({ path: "a.ts" });
    expect(parsed('{"name": "read_file", "arguments": "{\\"path\\": \\"a.ts\\"}"}')).toEqual({ path: "a.ts" });
    expect(parsed('{"name": "read_file", "arguments": {"path": "a.ts"}}')).toEqual({ path: "a.ts" });
  });

  it("closes missing braces and escapes raw newlines inside strings", () => {
    expect(parsed('{"path": "a.ts", "opts": {"limit": 3')).toEqual({ path: "a.ts", opts: { limit: 3 } });
    expect(parsed('{"path": "a.ts", "content": "line 1\nline 2"}')).toEqual({ path: "a.ts", content: "line 1\nline 2" });
  });

  it("refuses what it cannot repair safely", () => {
    // A string cut off mid-way would write half a file if it were closed.
    expect(repairToolArgs('{"path": "a.ts", "content": "line 1\nline')).toEqual({ ok: false });
    expect(repairToolArgs("just some words")).toEqual({ ok: false });
    expect(repairToolArgs("[1, 2]")).toEqual({ ok: false });
  });

  it("normalizes without touching string contents", () => {
    expect(normalizeJsonish('{"a": "x, }"}')).toBe('{"a": "x, }"}');
  });
});
