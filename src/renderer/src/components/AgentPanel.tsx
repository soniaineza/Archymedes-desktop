import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@shared/types";
import type { useAgent } from "../lib/useAgent";
import { MarkdownLite } from "./MarkdownLite";
import { SessionSwitcher } from "./SessionSwitcher";

interface Props {
  agent: ReturnType<typeof useAgent>;
  model: string;
  onOpenFile: (path: string, line?: number) => void;
  onOpenDiff: (path: string) => void;
  onRefreshTree: () => void;
  onOpenSettings: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "ready",
  thinking: "thinking…",
  "calling-tool": "running tool…",
  "awaiting-model": "waiting for model…",
  error: "error",
};

const SLASH_COMMANDS = [
  { cmd: "/clear", desc: "Start a new chat" },
  { cmd: "/sessions", desc: "Browse saved sessions" },
  { cmd: "/settings", desc: "Open provider settings" },
  { cmd: "/help", desc: "Show this help" },
];

const QUICK_STARTS = [
  "explain what this project does",
  "find bugs in @src",
  "write a README for this workspace",
];

function parseArg(args: string, key: string): string | null {
  try {
    const parsed = JSON.parse(args || "{}") as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function ToolCallView({ name, args, result, isError, onOpenFile, onOpenDiff }: {
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
}) {
  const parsedPath = parseArg(args, "path");
  const parsedCmd = parseArg(args, "command");
  const parsedQuery = parseArg(args, "query") ?? parseArg(args, "pattern");

  return (
    <div className={`tool-call${isError ? " error" : ""}`}>
      <div className="tool-name">
        <span className="glyph">{isError ? "✗" : result ? "✓" : "⏳"}</span>
        <span className="name">{name}</span>
        {(parsedPath || parsedCmd || parsedQuery) && (
          <span className="target">{parsedPath ?? parsedCmd ?? parsedQuery}</span>
        )}
      </div>
      {parsedPath && name !== "write_file" && name !== "edit_file" && (
        <button className="open-file-btn" onClick={() => onOpenFile(parsedPath!)}>open ↗</button>
      )}
      {parsedPath && (name === "write_file" || name === "edit_file") && (
        <span className="tool-links">
          <button className="open-file-btn" onClick={() => onOpenFile(parsedPath!)}>open ↗</button>
          <button className="open-file-btn diff" onClick={() => onOpenDiff(parsedPath!)}>diff ±</button>
        </span>
      )}
      {result && <div className="tool-result">{result}</div>}
    </div>
  );
}

function MessageView({ msg, onOpenFile, onOpenDiff }: {
  msg: ChatMessage;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="msg user">
        <div className="prompt-line">
          <span className="chevron">❯</span>
          <span className="user-text">
            {msg.content}
            {msg.queued && <span className="queued-chip">queued</span>}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="msg assistant">
      {msg.content && (
        <>
          <div className="content">
            <MarkdownLite text={msg.content} />
            {msg.pending && <span className="cursor-blink">▋</span>}
          </div>
          {!msg.pending && msg.content.trim().length > 0 && (
            <button
              className="copy-msg-btn"
              onClick={() => void navigator.clipboard.writeText(msg.content)}
              title="Copy message"
            >
              copy
            </button>
          )}
        </>
      )}
      {(msg.toolCalls ?? []).map((tc) => (
        <ToolCallView
          key={tc.id}
          name={tc.name}
          args={tc.args}
          result={tc.result}
          isError={tc.isError}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

export function AgentPanel({ agent, model, onOpenFile, onOpenDiff, onRefreshTree, onOpenSettings }: Props) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const busy = agent.status !== "idle" && agent.status !== "error";

  // ----- @file autocomplete -----
  // Active while the caret sits in a @token; ArrowUp/Down pick, Enter/Tab complete.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [allFiles, setAllFiles] = useState<string[]>([]);

  useEffect(() => {
    // Pull the workspace file list once the panel mounts and after sends.
    void window.archymedes.listDirTree("").then((nodes) => {
      const out: string[] = [];
      const walk = (list: { kind: string; path: string; children?: unknown[] }[]): void => {
        for (const n of list) {
          out.push(n.path);
          if (n.kind === "dir" && Array.isArray(n.children)) {
            walk(n.children as typeof list);
          }
        }
      };
      walk(nodes);
      setAllFiles(out.slice(0, 2000));
    });
  }, [agent.session.messages.length === 0, agent.session.id]);

  useEffect(() => {
    if (mentionQuery === null) return;
    const q = mentionQuery.toLowerCase();
    const scored = allFiles
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || a.length - b.length || a.localeCompare(b);
      })
      .slice(0, 8);
    setMentionItems(scored);
    setMentionIdx(0);
  }, [mentionQuery, allFiles]);

  const refreshMentionState = (text: string, caret: number): void => {
    const upTo = text.slice(0, caret);
    const match = /(?:^|\s)@([\w./-]*)$/.exec(upTo);
    setMentionQuery(match ? match[1] : null);
  };

  const applyMention = (path: string): void => {
    const el = composerRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? input.length;
    const upTo = input.slice(0, caret);
    const from = upTo.lastIndexOf("@", caret - 1);
    if (from >= 0) {
      const next = input.slice(0, from) + "@" + path + input.slice(caret);
      setInput(next);
      const pos = from + path.length + 1;
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      }, 0);
    }
    setMentionQuery(null);
  };
  // ----- end @file autocomplete -----

  // Track whether the user has scrolled away; if so, don't fight them.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [agent.session.messages, agent.status]);

  useEffect(() => {
    void agent.refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCommand = (raw: string): boolean => {
    const cmd = raw.trim().toLowerCase();
    if (cmd === "/clear" || cmd === "/new") {
      agent.reset();
      return true;
    }
    if (cmd === "/sessions") {
      agent.refreshSessions();
      agent.pushLocalNotice("Saved sessions are in the header dropdown — click the chat title to browse, rename, or delete.");
      return true;
    }
    if (cmd === "/settings") {
      onOpenSettings();
      return true;
    }
    if (cmd === "/help") {
      agent.pushLocalNotice(
        `commands:\n${SLASH_COMMANDS.map((c) => `  ${c.cmd.padEnd(12)} ${c.desc}`).join("\n")}\n\nshortcuts:\n  Ctrl+P          quick open file  (@ in the box → symbols)\n  Ctrl+1…9        jump to editor tab (9 = last)\n  Ctrl+Shift+P    command palette\n  Ctrl+Shift+F    search in files\n  Ctrl+B          toggle sidebar\n  Ctrl+J          toggle terminal\n  Ctrl+\`          focus terminal\n  Ctrl+K          focus agent input\n\ncontext:\n  @path/to/file   attach a file (or directory) to your message`,
      );
      return true;
    }
    return false;
  };

  const submit = () => {
    const text = input;
    setInput("");
    setMentionQuery(null);
    if (!text.trim()) return;
    setHistory((h) => [text, ...h].slice(0, 50));
    setHistoryIdx(-1);
    if (handleCommand(text)) return;
    agent.send(text);
    onRefreshTree();
  };

  // Ctrl+K focuses the composer from anywhere — the standard agent-chat hop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="agent-panel">
      <div className="agent-banner">
        <div className="banner-row">
          <span className="banner-logo">▣</span>
          <SessionSwitcher
            sessions={agent.sessions}
            currentId={agent.session.id}
            currentTitle={agent.session.title}
            dirtyFlag={agent.dirtyFlag}
            onSwitch={(id) => void agent.switchTo(id)}
            onNew={agent.reset}
            onRename={(id, title) => void agent.renameSessionLocal(id, title)}
            onDelete={(id) => void agent.removeSession(id)}
            onRefresh={agent.refreshSessions}
          />
          <span className={`banner-status${busy ? " busy" : ""}`}>{STATUS_LABEL[agent.status] ?? agent.status}</span>
        </div>
        <div className="banner-model">{model}</div>
      </div>

      <div className="agent-messages" ref={scrollRef} onScroll={onScroll}>
        {agent.session.messages.length === 0 && !agent.error && !agent.notice && (
          <div className="agent-hint">
            <div className="hint-title">Archymedes</div>
            <div>Coding agent for this workspace. Reads, edits, runs commands. Every edit is snapshotted — diff and revert anytime in the sidebar.</div>
            <div className="hint-commands">
              {SLASH_COMMANDS.map((c) => (
                <div key={c.cmd}><span className="cmd">{c.cmd}</span> {c.desc}</div>
              ))}
            </div>
            <div className="quick-start">
              try:{" "}
              {QUICK_STARTS.map((q, i) => (
                <span key={q}>
                  {i > 0 && " · "}
                  <span onClick={() => setInput(q)}>{q}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {agent.session.messages.map((msg) => (
          <MessageView key={msg.id} msg={msg} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
        ))}
        {agent.notice && <div className="msg notice">{agent.notice}</div>}
        {agent.error && <div className="msg error-text">✗ {agent.error}</div>}
      </div>

      <div className="agent-input">
        <span className={`input-chev${busy ? " busy" : ""}`}>❯</span>
        {mentionQuery !== null && mentionItems.length > 0 && (
          <div className="mention-menu">
            {mentionItems.map((f, i) => (
              <button
                key={f}
                className={`mention-item${i === mentionIdx ? " selected" : ""}`}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => applyMention(f)}
              >
                <span>{f.split("/").pop()}</span>
                <span className="hint">{f}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={composerRef}
          placeholder={busy ? "agent is working — your message will queue" : "message…  @file to attach  /help  ↑ history"}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            refreshMentionState(e.target.value, e.target.selectionStart ?? 0);
          }}
          onKeyDown={(e) => {
            // Mention popup captures navigation keys while open.
            if (mentionQuery !== null && mentionItems.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => Math.min(i + 1, mentionItems.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                applyMention(mentionItems[mentionIdx]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowUp" && !input.includes("\n") && history.length > 0) {
              e.preventDefault();
              const idx = Math.min(historyIdx + 1, history.length - 1);
              setHistoryIdx(idx);
              setInput(history[idx]);
            } else if (e.key === "ArrowDown" && historyIdx >= 0) {
              e.preventDefault();
              const idx = historyIdx - 1;
              setHistoryIdx(idx);
              setInput(idx >= 0 ? history[idx] : "");
            }
          }}
        />
        {busy ? (
          <button className="stop-btn" onClick={agent.cancel}>Stop</button>
        ) : (
          <button onClick={submit} disabled={!input.trim()}>Send</button>
        )}
      </div>
    </div>
  );
}
