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

  return (
    <div className={`tool-call${isError ? " error" : ""}`}>
      <div className="tool-name">
        <span className="glyph">{isError ? "✗" : result ? "✓" : "⏳"}</span>
        <span className="name">{name}</span>
        {(parsedPath || parsedCmd) && <span className="target">{parsedPath ?? parsedCmd}</span>}
      </div>
      {parsedPath && name === "read_file" && (
        <button className="open-file-btn" onClick={() => onOpenFile(parsedPath!)}>open ↗</button>
      )}
      {parsedPath && name === "write_file" && (
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
          <span className="user-text">{msg.content}</span>
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
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = agent.status !== "idle" && agent.status !== "error";

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
        `commands:\n${SLASH_COMMANDS.map((c) => `  ${c.cmd.padEnd(12)} ${c.desc}`).join("\n")}\n\nshortcuts:\n  Ctrl+P          quick open file\n  Ctrl+Shift+P    command palette\n  Ctrl+Shift+F    search in files\n  Ctrl+B          toggle sidebar\n  Ctrl+J          toggle terminal\n  Ctrl+\`          focus terminal\n\ncontext:\n  @path/to/file   attach a file to your message`,
      );
      return true;
    }
    return false;
  };

  const submit = () => {
    const text = input;
    setInput("");
    if (!text.trim()) return;
    setHistory((h) => [text, ...h].slice(0, 50));
    setHistoryIdx(-1);
    if (handleCommand(text)) return;
    agent.send(text);
    onRefreshTree();
  };

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

      <div className="agent-messages" ref={scrollRef}>
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
        <textarea
          placeholder={busy ? "agent is working — your message will queue" : "message…  @file to attach  /help  ↑ history"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
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
