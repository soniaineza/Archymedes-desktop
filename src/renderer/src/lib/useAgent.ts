import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_ERROR_CODES } from "@shared/types";
import type {
  AgentErrorCode,
  AgentEvent,
  AgentStatus,
  ChatMessage,
  CostInfo,
  SessionData,
  SessionSummary,
  ToolCallInfo,
} from "@shared/types";

/**
 * Renderer-side agent state machine with session persistence. The current
 * conversation autosaves after each run; sessions can be listed, reloaded,
 * renamed, and deleted.
 */

let nextId = 1;
const uid = (prefix: string): string => `${prefix}-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function newSession(): SessionData {
  const now = Date.now();
  return { id: uid("s"), title: "", createdAt: now, updatedAt: now, messages: [] };
}

function titleFrom(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 60);
}

export type AgentErrorKind = AgentErrorCode | "no-api-key" | "no-workspace";

export interface AgentErrorInfo {
  /** Untranslated detail, shown when there is no code or alongside it. */
  message: string;
  code?: AgentErrorKind;
  params?: Record<string, number>;
}

const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;

function errorFromUnknown(err: unknown): AgentErrorInfo {
  const message = (err instanceof Error ? err.message : String(err)).replace(IPC_ERROR_PREFIX, "");
  if (message.includes(AGENT_ERROR_CODES.noApiKey)) return { message, code: "no-api-key" };
  if (message.includes(AGENT_ERROR_CODES.noWorkspace)) return { message, code: "no-workspace" };
  return { message };
}

function withoutQueued(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !m.queued);
}

const isBusy = (status: AgentStatus): boolean => status !== "idle" && status !== "error";

export function useAgent(options: { onRunFinished?: () => void } = {}) {
  const [session, setSession] = useState<SessionData>(newSession);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<AgentErrorInfo | null>(null);
  const [usage, setUsage] = useState<CostInfo | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [dirtyFlag, setDirtyFlag] = useState(0); // bump to trigger session-list refresh

  const sessionRef = useRef<SessionData>(session);
  const queueRef = useRef<string[]>([]);
  const dirtyRef = useRef(false);
  const onRunFinishedRef = useRef(options.onRunFinished);
  sessionRef.current = session;
  queueRef.current = queue;
  onRunFinishedRef.current = options.onRunFinished;
  const busy = isBusy(status);

  const refreshSessions = useCallback(async () => {
    setSessions(await window.archymedes.listSessions());
  }, []);

  const persist = useCallback(async (data: SessionData) => {
    await window.archymedes.saveSession({ ...data, messages: withoutQueued(data.messages) });
    setDirtyFlag((n) => n + 1);
  }, []);

  const handleEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "status":
        setStatus(event.status);
        break;
      case "message-start":
        setSession((s) => ({
          ...s,
          messages: [...s.messages, { id: event.id, role: "assistant", content: "", pending: true, toolCalls: [] }],
        }));
        dirtyRef.current = true;
        break;
      case "text-delta":
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) => (m.id === event.id ? { ...m, content: m.content + event.delta } : m)),
        }));
        break;
      case "tool-start":
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === event.id
              ? {
                  ...m,
                  toolCalls: [...(m.toolCalls ?? []), { id: event.toolCallId, name: event.name, args: event.args } as ToolCallInfo],
                }
              : m,
          ),
        }));
        break;
      case "tool-result":
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.toolCalls?.some((tc) => tc.id === event.toolCallId)
              ? {
                  ...m,
                  toolCalls: m.toolCalls.map((tc) =>
                    tc.id === event.toolCallId ? { ...tc, result: event.result, isError: event.isError } : tc,
                  ),
                }
              : m,
          ),
        }));
        break;
      case "message-end":
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) => (m.id === event.id ? { ...m, pending: false } : m)),
        }));
        break;
      case "cost":
        setUsage(event.cost);
        break;
      case "done":
        setStatus("idle");
        break;
      case "error":
        setError({ message: event.message, code: event.code, params: event.params });
        setStatus("error");
        break;
    }
  }, []);

  useEffect(() => window.archymedes.onAgentEvent(handleEvent), [handleEvent]);

  const sendRef = useRef<((text: string) => void) | null>(null);

  // Autosave and queue-drain run once per busy → settled transition, in an
  // effect so a render that React repeats or discards can't fire them twice.
  const lastStatusRef = useRef<AgentStatus>("idle");
  useEffect(() => {
    const wasBusy = isBusy(lastStatusRef.current);
    lastStatusRef.current = status;
    if (!wasBusy || isBusy(status)) return;

    if (dirtyRef.current) {
      dirtyRef.current = false;
      void persist({ ...sessionRef.current, updatedAt: Date.now() });
    }
    if (status !== "idle") return;

    const [next, ...rest] = queueRef.current;
    if (next === undefined) {
      onRunFinishedRef.current?.();
      return;
    }
    setQueue(rest);
    setSession((s) => {
      const idx = s.messages.findIndex((m) => m.queued && m.content === next);
      return idx === -1 ? s : { ...s, messages: s.messages.filter((_, i) => i !== idx) };
    });
    setTimeout(() => sendRef.current?.(next), 50);
  }, [status, persist]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError(null);

      if (isBusy(lastStatusRef.current)) {
        setQueue((q) => [...q, trimmed]);
        setSession((s) => ({
          ...s,
          messages: [...s.messages, { id: uid("queued"), role: "user", content: trimmed, queued: true }],
        }));
        return;
      }

      const current = sessionRef.current;
      const next: SessionData = {
        ...current,
        title: current.title || titleFrom(trimmed),
        messages: [...current.messages, { id: uid("user"), role: "user", content: trimmed }],
        updatedAt: Date.now(),
      };
      sessionRef.current = next;
      setSession(next);
      void window.archymedes.sendAgentMessage(withoutQueued(next.messages), next.id).catch((err: unknown) => {
        setError(errorFromUnknown(err));
        setStatus("error");
      });
    },
    [],
  );
  sendRef.current = send;

  const cancel = useCallback(() => {
    window.archymedes.cancelAgent();
  }, []);

  const reset = useCallback(() => {
    setSession(newSession());
    setStatus("idle");
    setError(null);
    setQueue([]);
    setUsage(null);
  }, []);

  const switchTo = useCallback(async (id: string) => {
    const data = await window.archymedes.loadSession(id);
    if (data) {
      setSession(data);
      setStatus("idle");
      setError(null);
      setQueue([]);
      setUsage(null);
    }
  }, []);

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

  return {
    session,
    sessions,
    dirtyFlag,
    status,
    busy,
    error,
    usage,
    queue,
    send,
    cancel,
    reset,
    switchTo,
    removeSession,
    renameSessionLocal,
    refreshSessions,
  };
}

export type AgentController = ReturnType<typeof useAgent>;
