import { useCallback, useRef, useState } from "react";
import type { AgentEvent, AgentStatus, ChatMessage, SessionData, SessionSummary, ToolCallInfo } from "@shared/types";

/**
 * Renderer-side agent state machine with session persistence. The current
 * conversation autosaves after each turn; sessions can be listed, reloaded,
 * renamed, and deleted — the desktop equivalent of the CLI's "resume" story.
 */

let nextId = 1;
const uid = (prefix: string): string => `${prefix}-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function newSession(): SessionData {
  const now = Date.now();
  return { id: uid("s"), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

function titleFrom(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.slice(0, 60) || "New chat";
}

export function useAgent() {
  const [session, setSession] = useState<SessionData>(newSession);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ input: number; output: number; formatted?: string; unpriced?: boolean } | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [dirtyFlag, setDirtyFlag] = useState(0); // bump to trigger session-list refresh

  const listenersBoundRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sessionRef = useRef<SessionData>(session);
  const queueRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  messagesRef.current = session.messages;
  sessionRef.current = session;
  queueRef.current = queue;
  busyRef.current = status !== "idle" && status !== "error";

  const refreshSessions = useCallback(async () => {
    setSessions(await window.archymedes.listSessions());
  }, []);

  const persist = useCallback(async (data: SessionData) => {
    await window.archymedes.saveSession(data);
    setDirtyFlag((n) => n + 1);
  }, []);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          break;
        case "message-start":
          setSession((s) => ({
            ...s,
            messages: [
              ...s.messages,
              { id: event.id, role: "assistant", content: "", pending: true, toolCalls: [] },
            ],
          }));
          dirtyRef.current = true;
          break;
        case "text-delta":
          setSession((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === event.id ? { ...m, content: m.content + event.delta } : m,
            ),
          }));
          break;
        case "tool-start":
          setSession((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === event.id
                ? {
                    ...m,
                    toolCalls: [
                      ...(m.toolCalls ?? []),
                      { id: event.toolCallId, name: event.name, args: event.args } as ToolCallInfo,
                    ],
                  }
                : m,
            ),
          }));
          break;
        case "tool-result":
          setSession((s) => ({
            ...s,
            messages: s.messages.map((m) => ({
              ...m,
              toolCalls: (m.toolCalls ?? []).map((tc) =>
                tc.id === event.toolCallId
                  ? { ...tc, result: event.result, isError: event.isError }
                  : tc,
              ),
            })),
          }));
          break;
        case "message-end":
          setSession((s) => ({
            ...s,
            messages: s.messages.map((m) => (m.id === event.id ? { ...m, pending: false } : m)),
          }));
          break;
        case "cost":
          // Priced through the CLI core's dated catalog, cached tokens included.
          setUsage({
            input: event.cost.inputTokens,
            output: event.cost.outputTokens,
            formatted: event.cost.formatted,
            unpriced: event.cost.unpriced,
          });
          break;
        case "done":
          setStatus("idle");
          break;
        case "error":
          setError(event.message);
          setStatus("error");
          break;
      }
    },
    [],
  );

  const ensureListener = useCallback(() => {
    if (!listenersBoundRef.current) {
      window.archymedes.onAgentEvent(handleEvent);
      listenersBoundRef.current = true;
    }
  }, [handleEvent]);

  // Autosave after streams settle.
  const lastStatusRef = useRef<AgentStatus>("idle");
  if (lastStatusRef.current !== "idle" && status === "idle" && dirtyRef.current) {
    dirtyRef.current = false;
    void persist({ ...sessionRef.current, updatedAt: Date.now() });
  }
  if (lastStatusRef.current !== "idle" && status === "idle" && queueRef.current.length > 0) {
    const next = queueRef.current[0];
    setQueue(queueRef.current.slice(1));
    if (next) setTimeout(() => sendRef.current?.(next), 50);
  }
  lastStatusRef.current = status;

  const dispatch = useCallback(async (data: SessionData) => {
    await window.archymedes.sendAgentMessage(data.messages, data.id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
    });
  }, []);

  const sendRef = useRef<((text: string) => void) | null>(null);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      ensureListener();
      setError(null);
      setNotice(null);

      if (busyRef.current) {
        setQueue((q) => [...q, trimmed]);
        setSession((s) => ({
          ...s,
          messages: [...s.messages, { id: uid("queued"), role: "user" as const, content: `${trimmed}  (queued)` }],
        }));
        return;
      }

      setSession((s) => {
        const userMsg: ChatMessage = { id: uid("user"), role: "user", content: trimmed };
        const next: SessionData = {
          ...s,
          title: s.messages.length === 0 ? titleFrom(trimmed) : s.title,
          messages: [...s.messages, userMsg],
          updatedAt: Date.now(),
        };
        void dispatch(next);
        return next;
      });
    },
    [dispatch, ensureListener],
  );
  sendRef.current = send;

  const cancel = useCallback(() => {
    window.archymedes.cancelAgent();
  }, []);

  const reset = useCallback(() => {
    setSession(newSession());
    setStatus("idle");
    setError(null);
    setNotice(null);
    setQueue([]);
    setUsage(null);
  }, []);

  const switchTo = useCallback(
    async (id: string) => {
      const data = await window.archymedes.loadSession(id);
      if (data) {
        setSession(data);
        setStatus("idle");
        setError(null);
        setNotice(null);
      }
    },
    [],
  );

  const removeSession = useCallback(
    async (id: string) => {
      await window.archymedes.deleteSession(id);
      if (id === sessionRef.current.id) reset();
      void refreshSessions();
    },
    [refreshSessions, reset],
  );

  const renameSessionLocal = useCallback(
    async (id: string, title: string) => {
      await window.archymedes.renameSession(id, title);
      if (id === sessionRef.current.id) setSession((s) => ({ ...s, title }));
      void refreshSessions();
    },
    [refreshSessions],
  );

  /** Show an error line in the chat without involving the agent. */
  const pushLocalError = useCallback((message: string) => {
    setError(message);
  }, []);

  /** Show an informational line in the chat (e.g. /help output). */
  const pushLocalNotice = useCallback((message: string) => {
    setNotice(message);
  }, []);

  return {
    session, sessions, dirtyFlag,
    status, error, notice, usage, queue,
    send, cancel, reset, switchTo, removeSession, renameSessionLocal,
    refreshSessions, pushLocalError, pushLocalNotice,
  };
}
