import { describe, expect, it } from "vitest";
import type { RuntimeTurn } from "./adapter";
import {
  EARLIER_TOOL_ARGS_STUB,
  EARLIER_TOOL_RESULT_STUB,
  FREE_TOKEN_SAVER,
  capText,
  currentRunStart,
  estimateTokens,
  historyBudget,
  omittedNote,
  stubEarlierToolResults,
  tokenSaverFor,
  trimToBudget,
} from "./token-saver";

const user = (text: string): RuntimeTurn => ({ kind: "text", role: "user", text });
const assistant = (text: string): RuntimeTurn => ({ kind: "text", role: "assistant", text });
const call = (id: string, args = "{}"): RuntimeTurn => ({ kind: "assistant-toolcalls", text: "", calls: [{ toolCallId: id, name: "read_file", args }] });
const result = (id: string, text: string): RuntimeTurn => ({
  kind: "tool-results",
  results: [{ toolCallId: id, name: "read_file", args: "{}", result: text, isError: false }],
});

describe("tokenSaverFor", () => {
  it("is on for free mode only", () => {
    expect(tokenSaverFor("free")).toBe(FREE_TOKEN_SAVER);
    expect(tokenSaverFor("anthropic")).toBeNull();
    expect(tokenSaverFor("openai-compatible")).toBeNull();
  });
});

describe("capText", () => {
  it("leaves short text alone and says how much a cut dropped", () => {
    expect(capText("abc", 5)).toBe("abc");
    const cut = capText("x".repeat(20), 10, "file");
    expect(cut.startsWith("x".repeat(10) + "\n")).toBe(true);
    expect(cut).toContain("file truncated at 10 of 20 chars");
  });
});

describe("currentRunStart", () => {
  it("is the last user message, or the end when there is none", () => {
    expect(currentRunStart([user("a"), assistant("b"), user("c")])).toBe(2);
    expect(currentRunStart([assistant("b")])).toBe(1);
  });
});

describe("stubEarlierToolResults", () => {
  it("stubs results and bulky arguments from earlier runs, keeping the call/result pairing", () => {
    const big = "y".repeat(5_000);
    const turns = [user("one"), call("c1", JSON.stringify({ content: big })), result("c1", big), assistant("done"), user("two")];
    const stubbed = stubEarlierToolResults(turns, 4);
    expect(stubbed[1]).toMatchObject({ kind: "assistant-toolcalls", calls: [{ toolCallId: "c1", name: "read_file", args: EARLIER_TOOL_ARGS_STUB }] });
    expect(stubbed[2]).toMatchObject({ kind: "tool-results", results: [{ toolCallId: "c1", result: EARLIER_TOOL_RESULT_STUB }] });
    expect(JSON.parse(EARLIER_TOOL_ARGS_STUB)).toBeTypeOf("object");
    expect(stubbed[4]).toBe(turns[4]);
  });

  it("keeps the current run's results and short earlier ones untouched", () => {
    const turns = [user("one"), call("c1"), result("c1", "ok"), user("two"), call("c2"), result("c2", "z".repeat(500))];
    const stubbed = stubEarlierToolResults(turns, 3);
    expect(stubbed[2]).toEqual(turns[2]);
    expect(stubbed[5]).toBe(turns[5]);
  });
});

describe("historyBudget", () => {
  it("is the smaller of the cap and a share of the window", () => {
    expect(historyBudget(200_000, FREE_TOKEN_SAVER)).toBe(16_000);
    expect(historyBudget(10_000, FREE_TOKEN_SAVER)).toBe(6_000);
    expect(historyBudget(0, FREE_TOKEN_SAVER)).toBe(16_000);
  });
});

describe("trimToBudget", () => {
  const filler = (n: number) => "w".repeat(n * 4); // n estimated tokens

  it("sends everything when it fits", () => {
    const turns = [user("a"), assistant("b"), user("c")];
    expect(trimToBudget("sys", turns, 2, 1_000)).toEqual({ turns, omitted: 0 });
  });

  it("drops the oldest whole exchanges, never splitting a tool call from its result", () => {
    const turns = [
      user(filler(100)), call("c1"), result("c1", filler(400)), assistant(filler(50)),
      user(filler(100)), assistant(filler(100)),
      user("now"),
    ];
    const { turns: sent, omitted } = trimToBudget("", turns, 6, 300);
    expect(omitted).toBe(4);
    expect(sent).toEqual([user(omittedNote(4)), user(filler(100)), assistant(filler(100)), user("now")]);
    // No tool result is left without its call.
    const callIds = sent.flatMap((t) => (t.kind === "assistant-toolcalls" ? t.calls.map((c) => c.toolCallId) : []));
    const resultIds = sent.flatMap((t) => (t.kind === "tool-results" ? t.results.map((r) => r.toolCallId) : []));
    expect(resultIds.every((id) => callIds.includes(id))).toBe(true);
  });

  it("always keeps the system prompt budget and the current run, even over budget", () => {
    const turns = [user("old"), assistant("reply"), user(filler(500)), call("c1"), result("c1", filler(500))];
    const { turns: sent, omitted } = trimToBudget(filler(100), turns, 2, 50);
    expect(omitted).toBe(2);
    expect(sent.slice(1)).toEqual(turns.slice(2));
  });

  it("keeps the request within budget whenever the current run fits", () => {
    const turns: RuntimeTurn[] = [];
    for (let i = 0; i < 20; i++) turns.push(user(filler(200)), call(`c${i}`), result(`c${i}`, filler(800)));
    turns.push(user("latest"));
    const { turns: sent } = trimToBudget("system", turns, turns.length - 1, 4_000);
    const size = sent.reduce((sum, t) => sum + (t.kind === "text" ? estimateTokens(t.text) : t.kind === "tool-results" ? estimateTokens(t.results[0].result) : 1), 0);
    expect(size).toBeLessThanOrEqual(4_000);
    expect(sent.at(-1)).toEqual(user("latest"));
  });
});
