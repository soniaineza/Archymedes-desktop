import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppError, toTransportError } from "@shared/app-error";
import type { AgentEvent, ChatMessage } from "@shared/types";
import { fakeApi } from "../../test/fake-api";
import { useAgent } from "./useAgent";

/** Delivers events one at a time, the way separate IPC messages reach the renderer. */
function emit(...events: AgentEvent[]) {
  for (const event of events) {
    act(() => fakeApi().emitAgentEvent(event));
  }
}

/** A complete assistant reply, ending with the run going idle. */
function reply(id: string, text: string): AgentEvent[] {
  return [
    { type: "message-start", id },
    { type: "text-delta", id, delta: text },
    { type: "message-end", id },
    { type: "status", status: "idle" },
    { type: "done" },
  ];
}

const sentHistories = () => vi.mocked(fakeApi().sendAgentMessage).mock.calls.map(([history]) => history);
const contents = (history: ChatMessage[]) => history.map((m) => `${m.role}:${m.content}`);

describe("useAgent", () => {
  it("sends the conversation and titles the session from the first message", () => {
    const { result } = renderHook(() => useAgent());

    act(() => result.current.send("  explain this project\nplease "));

    expect(contents(sentHistories()[0])).toEqual(["user:explain this project\nplease"]);
    expect(result.current.session.title).toBe("explain this project");
  });

  it("queues messages while the agent is busy, then sends them once it settles", async () => {
    const { result } = renderHook(() => useAgent());

    act(() => result.current.send("first"));
    emit({ type: "status", status: "thinking" });
    act(() => result.current.send("second"));

    expect(fakeApi().sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(result.current.queue).toEqual(["second"]);
    expect(result.current.session.messages.at(-1)).toMatchObject({ content: "second", queued: true });

    emit(...reply("m1", "done with first"));

    await waitFor(() => expect(fakeApi().sendAgentMessage).toHaveBeenCalledTimes(2));
    // The queued placeholder is replaced by the real message, never sent twice.
    expect(contents(sentHistories()[1])).toEqual(["user:first", "assistant:done with first", "user:second"]);
    expect(result.current.queue).toEqual([]);
  });

  it("persists the user message immediately on send, without UI-only queued messages", async () => {
    const { result } = renderHook(() => useAgent());

    act(() => result.current.send("first"));

    // Crash safety: the user's words hit disk before the run even starts.
    await waitFor(() => expect(fakeApi().saveSession).toHaveBeenCalledTimes(1));
    const [sent] = vi.mocked(fakeApi().saveSession).mock.calls[0];
    expect(sent.messages.some((m) => m.queued)).toBe(false);
    expect(sent.messages.at(-1)).toMatchObject({ role: "user", content: "first" });

    emit({ type: "status", status: "thinking" });
    act(() => result.current.send("later"));
    emit(...reply("m1", "ok"));

    // The run-end autosave still fires, now including the assistant reply.
    await waitFor(() => expect(fakeApi().saveSession).toHaveBeenCalledTimes(2));
    const [saved] = vi.mocked(fakeApi().saveSession).mock.calls[1];
    expect(saved.messages.some((m) => m.queued)).toBe(false);
    expect(saved.messages.at(-1)).toMatchObject({ role: "assistant", content: "ok" });
  });

  it("reports that the run finished only when nothing else is queued", async () => {
    const onRunFinished = vi.fn();
    const { result } = renderHook(() => useAgent({ onRunFinished }));

    act(() => result.current.send("go"));
    emit({ type: "status", status: "thinking" }, ...reply("m1", "ok"));

    await waitFor(() => expect(onRunFinished).toHaveBeenCalledOnce());
  });

  it("keeps structured error codes that crossed IPC", async () => {
    const rejection = new Error(
      `Error invoking remote method 'agent:send': Error: ${toTransportError(new AppError("no-api-key", "missing key")).message}`,
    );
    vi.mocked(fakeApi().sendAgentMessage).mockRejectedValueOnce(rejection);
    const { result } = renderHook(() => useAgent());

    act(() => result.current.send("hello"));

    await waitFor(() => expect(result.current.error?.code).toBe("no-api-key"));
    expect(result.current.status).toBe("error");
  });

  it("surfaces error events from the running agent", () => {
    const { result } = renderHook(() => useAgent());

    emit({ type: "error", message: "Reached the iteration limit (40).", code: "iteration-limit", params: { count: 40 } });

    expect(result.current.error).toEqual({ message: "Reached the iteration limit (40).", code: "iteration-limit", params: { count: 40 } });
    expect(result.current.status).toBe("error");
  });

  it("attaches tool results to the right tool call", () => {
    const { result } = renderHook(() => useAgent());

    emit(
      { type: "message-start", id: "m1" },
      { type: "tool-start", id: "m1", toolCallId: "t1", name: "read_file", args: '{"path":"a.ts"}' },
      { type: "tool-result", toolCallId: "t1", result: "contents", isError: false },
    );

    expect(result.current.session.messages[0].toolCalls).toEqual([
      { id: "t1", name: "read_file", args: '{"path":"a.ts"}', result: "contents", isError: false },
    ]);
  });
});
