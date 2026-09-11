import { describe, expect, it } from "vitest";
import { historyToTurns } from "./adapter";

describe("historyToTurns", () => {
  it("returns all tool results of one assistant turn in a single tool-results turn", () => {
    const turns = historyToTurns([
      { id: "u1", role: "user", content: "go" },
      {
        id: "a1",
        role: "assistant",
        content: "reading",
        toolCalls: [
          { id: "t1", name: "read_file", args: '{"path":"a"}', result: "A" },
          { id: "t2", name: "read_file", args: '{"path":"b"}', result: "boom", isError: true },
        ],
      },
    ]);

    expect(turns).toHaveLength(3);
    expect(turns[1]).toMatchObject({ kind: "assistant-toolcalls", text: "reading" });
    expect(turns[2]).toEqual({
      kind: "tool-results",
      results: [
        { toolCallId: "t1", name: "read_file", args: '{"path":"a"}', result: "A", isError: false },
        { toolCallId: "t2", name: "read_file", args: '{"path":"b"}', result: "boom", isError: true },
      ],
    });
  });

  it("fills a placeholder for tool calls that never got a result", () => {
    const turns = historyToTurns([
      { id: "a1", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "run_command", args: "{}" }] },
    ]);
    expect(turns[1]).toMatchObject({ results: [{ result: "(no result)", isError: false }] });
  });

  it("skips empty text messages", () => {
    expect(historyToTurns([{ id: "a1", role: "assistant", content: "  " }])).toEqual([]);
  });
});
