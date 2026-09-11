import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ChatMessage, ToolCallInfo } from "@shared/types";
import type { AgentController, AgentErrorInfo } from "../lib/useAgent";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";
import { Icon } from "./Icon";
import { CopyButton, MarkdownLite } from "./MarkdownLite";
import { SessionSwitcher } from "./SessionSwitcher";

interface Props {
  agent: AgentController;
  modelLabel: string;
  hasKey: boolean;
  files: string[];
  onOpenFile: (path: string, line?: number) => void;
  onOpenDiff: (path: string) => void;
  onOpenSettings: () => void;
}

const SLASH_COMMANDS: readonly { cmd: string; key: MessageKey }[] = [
  { cmd: "/clear", key: "agent.cmd.clear" },
  { cmd: "/sessions", key: "agent.cmd.sessions" },
  { cmd: "/settings", key: "agent.cmd.settings" },
  { cmd: "/help", key: "agent.cmd.help" },
];

const SHORTCUTS: readonly [string, MessageKey][] = [
  ["mod+p", "cmd.quickOpen"],
  ["mod+shift+p", "status.commands"],
  ["mod+shift+f", "cmd.search"],
  ["mod+b", "cmd.toggleSidebar"],
  ["mod+j", "cmd.toggleTerminal"],
  ["mod+alt+b", "cmd.toggleAgent"],
  ["mod+`", "cmd.focusTerminal"],
];

const SUGGESTIONS: readonly MessageKey[] = ["agent.suggestion1", "agent.suggestion2", "agent.suggestion3", "agent.suggestion4"];

const TOOL_LABELS: Record<string, MessageKey> = {
  read_file: "tool.read_file",
  write_file: "tool.write_file",
  edit_file: "tool.edit_file",
  list_dir: "tool.list_dir",
  glob_files: "tool.glob_files",
  grep_files: "tool.grep_files",
  run_command: "tool.run_command",
};
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

const MENTION_BEFORE_CARET = /(?:^|\s)@([\w./-]*)$/;

function parseArgs(args: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(args || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolTarget(args: Record<string, unknown>): string | null {
  for (const key of ["path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function ToolCallView({ call, onOpenFile, onOpenDiff }: {
  call: ToolCallInfo;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(Boolean(call.isError));
  useEffect(() => {
    if (call.isError) setOpen(true);
  }, [call.isError]);

  const args = useMemo(() => parseArgs(call.args), [call.args]);
  const target = toolTarget(args);
  const path = typeof args.path === "string" && args.path ? args.path : null;
  const state = call.result === undefined ? "running" : call.isError ? "failed" : "done";
  const labelKey = TOOL_LABELS[call.name];

  return (
    <div className={`tool-call ${state}`}>
      <div className="tool-row">
        <button
          className="tool-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          disabled={state === "running"}
          title={state === "running" ? t("agent.toolRunning") : open ? t("agent.hideOutput") : t("agent.showOutput")}
        >
          <span className="tool-state">
            {state === "running" ? (
              <Icon name="loader" size={13} className="spin" />
            ) : state === "failed" ? (
              <Icon name="alert" size={13} />
            ) : (
              <Icon name="check" size={13} />
            )}
          </span>
          <span className="tool-label">{labelKey ? t(labelKey) : call.name}</span>
          {target && (
            <bdi className="tool-target" dir="ltr">
              {target}
            </bdi>
          )}
          {state !== "running" && (
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} flipRtl className="tool-chevron" />
          )}
        </button>
        {path && FILE_TOOLS.has(call.name) && (
          <button className="tool-link" onClick={() => onOpenFile(path)}>
            <Icon name="external" size={12} />
            {t("agent.openFile")}
          </button>
        )}
        {path && EDIT_TOOLS.has(call.name) && state === "done" && (
          <button className="tool-link" onClick={() => onOpenDiff(path)}>
            <Icon name="diff" size={12} />
            {t("agent.viewDiff")}
          </button>
        )}
      </div>
      {open && call.result !== undefined && (
        <pre className="tool-output" dir="ltr">
          {call.result}
        </pre>
      )}
    </div>
  );
}

function MessageView({ msg, onOpenFile, onOpenDiff }: {
  msg: ChatMessage;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string) => void;
}) {
  const { t } = useI18n();

  if (msg.role === "user") {
    return (
      <div className={`msg user${msg.queued ? " queued" : ""}`}>
        <div className="bubble" dir="auto">
          {msg.content}
        </div>
        {msg.queued && <span className="queued-badge">{t("agent.queued")}</span>}
      </div>
    );
  }

  const hasText = msg.content.trim().length > 0;
  const toolCalls = msg.toolCalls ?? [];
  return (
    <div className="msg assistant">
      <div className="avatar" aria-hidden>
        <Icon name="logo" size={15} />
      </div>
      <div className="msg-body">
        {hasText && (
          <div className="markdown">
            <MarkdownLite text={msg.content} />
            {msg.pending && <span className="stream-caret" />}
          </div>
        )}
        {!hasText && msg.pending && toolCalls.length === 0 && (
          <div className="typing" aria-label={t("agent.status.thinking")}>
            <span />
            <span />
            <span />
          </div>
        )}
        {toolCalls.map((tc) => (
          <ToolCallView key={tc.id} call={tc} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
        ))}
        {!msg.pending && hasText && (
          <div className="msg-actions">
            <CopyButton text={msg.content} label={t("agent.copyMessage")} />
          </div>
        )}
      </div>
    </div>
  );
}

type Suggestion = { kind: "command" | "file"; value: string; detail: string };

export function AgentPanel({ agent, modelLabel, hasKey, files, onOpenFile, onOpenDiff, onOpenSettings }: Props) {
  const { t, shortcut } = useI18n();
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [notice, setNotice] = useState<"help" | "sessions" | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { busy, session, error } = agent;

  useEffect(() => {
    void agent.refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setNotice(null);
    stickRef.current = true;
  }, [session.id]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [session.messages, error, notice]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (suggestionsDismissed) return [];
    if (/^\/\S*$/.test(input)) {
      const typed = input.toLowerCase();
      return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(typed) && c.cmd !== typed).map((c) => ({
        kind: "command",
        value: c.cmd,
        detail: t(c.key),
      }));
    }
    const mention = MENTION_BEFORE_CARET.exec(input.slice(0, caret));
    if (!mention) return [];
    const query = mention[1].toLowerCase();
    return files
      .filter((f) => f.toLowerCase().includes(query))
      .map((f) => {
        const base = f.slice(f.lastIndexOf("/") + 1).toLowerCase();
        return { f, rank: base.startsWith(query) ? 0 : base.includes(query) ? 1 : 2 };
      })
      .sort((a, b) => a.rank - b.rank || a.f.length - b.f.length)
      .slice(0, 8)
      .map(({ f }) => ({ kind: "file", value: f, detail: "" }));
  }, [caret, files, input, suggestionsDismissed, t]);

  useEffect(() => setActiveSuggestion(0), [suggestions.length]);

  const applySuggestion = (s: Suggestion) => {
    if (s.kind === "command") {
      setInput(s.value);
      setCaret(s.value.length);
      return;
    }
    const before = input.slice(0, caret).replace(/@([\w./-]*)$/, `@${s.value} `);
    const next = before + input.slice(caret);
    setInput(next);
    setCaret(before.length);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(before.length, before.length));
  };

  const handleCommand = (raw: string): boolean => {
    const cmd = raw.trim().toLowerCase();
    if (cmd === "/clear" || cmd === "/new") {
      agent.reset();
      return true;
    }
    if (cmd === "/sessions") {
      void agent.refreshSessions();
      setNotice("sessions");
      return true;
    }
    if (cmd === "/settings") {
      onOpenSettings();
      return true;
    }
    if (cmd === "/help") {
      setNotice("help");
      return true;
    }
    return false;
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setCaret(0);
    setHistory((h) => [text, ...h.filter((entry) => entry !== text)].slice(0, 50));
    setHistoryIdx(-1);
    setNotice(null);
    if (handleCommand(text)) return;
    stickRef.current = true;
    agent.send(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Never act on keys that belong to an IME composition (Chinese, Japanese, Korean input).
    if (e.nativeEvent.isComposing) return;

    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveSuggestion((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applySuggestion(suggestions[activeSuggestion] ?? suggestions[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestionsDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && !input.includes("\n") && history.length > 0 && (input === "" || historyIdx >= 0)) {
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
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = near;
    setAtBottom(near);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const errorText = (err: AgentErrorInfo): string => {
    switch (err.code) {
      case "no-api-key":
        return t("agent.error.noApiKey");
      case "no-workspace":
        return t("agent.error.noWorkspace");
      case "iteration-limit":
        return t("agent.error.iterationLimit", { count: err.params?.count ?? 0 });
      default:
        return err.message;
    }
  };

  const empty = session.messages.length === 0 && !error && !notice;

  return (
    <aside className="agent-panel" aria-label={t("titlebar.toggleAgent")}>
      <header className="agent-header">
        <SessionSwitcher
          sessions={agent.sessions}
          currentId={session.id}
          currentTitle={session.title}
          dirtyFlag={agent.dirtyFlag}
          onSwitch={(id) => void agent.switchTo(id)}
          onNew={agent.reset}
          onRename={(id, title) => void agent.renameSessionLocal(id, title)}
          onDelete={(id) => void agent.removeSession(id)}
          onRefresh={() => void agent.refreshSessions()}
        />
        <button className="icon-btn" onClick={agent.reset} title={t("sessions.new")} aria-label={t("sessions.new")}>
          <Icon name="plus" size={16} />
        </button>
      </header>
      <div className="agent-subheader">
        <span className="model-chip" title={modelLabel}>
          <Icon name="cpu" size={12} />
          <bdi>{modelLabel}</bdi>
        </span>
        <span className={`agent-state ${agent.status}`}>
          <span className={`state-dot${busy ? " pulse" : ""}`} />
          {t(`agent.status.${agent.status}`)}
        </span>
      </div>

      <div className="agent-messages" ref={scrollRef} onScroll={onScroll}>
        {empty && (
          <div className="agent-empty">
            <div className="agent-empty-mark" aria-hidden>
              <Icon name="logo" size={28} />
            </div>
            <p className="agent-intro">{t("agent.intro")}</p>
            {!hasKey && (
              <button className="callout warn" onClick={onOpenSettings}>
                <Icon name="alert" size={15} />
                <span>{t("agent.error.noApiKey")}</span>
              </button>
            )}
            <div className="suggestions-title">{t("agent.suggestionsTitle")}</div>
            <div className="suggestions">
              {SUGGESTIONS.map((key) => (
                <button
                  key={key}
                  className="suggestion"
                  onClick={() => {
                    setInput(t(key));
                    inputRef.current?.focus();
                  }}
                >
                  <Icon name="sparkles" size={14} />
                  <span dir="auto">{t(key)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {session.messages.map((msg) => (
          <MessageView key={msg.id} msg={msg} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
        ))}

        {notice === "help" && (
          <div className="notice-card">
            <div className="notice-title">{t("agent.help.commands")}</div>
            <dl className="kv">
              {SLASH_COMMANDS.map((c) => (
                <div key={c.cmd}>
                  <dt>
                    <code>{c.cmd}</code>
                  </dt>
                  <dd>{t(c.key)}</dd>
                </div>
              ))}
              <div>
                <dt>
                  <code>@path</code>
                </dt>
                <dd>{t("agent.help.context")}</dd>
              </div>
            </dl>
            <div className="notice-title">{t("agent.help.shortcuts")}</div>
            <dl className="kv">
              {SHORTCUTS.map(([keys, label]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{shortcut(keys)}</kbd>
                  </dt>
                  <dd>{t(label)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {notice === "sessions" && <div className="notice-card">{t("agent.sessionsNotice")}</div>}

        {error && (
          <div className="callout error" role="alert">
            <Icon name="alert" size={15} />
            <div className="callout-body">
              <div dir="auto">{errorText(error)}</div>
              {error.code === "no-api-key" && (
                <button className="btn small" onClick={onOpenSettings}>
                  {t("titlebar.settings")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {!atBottom && (
        <button className="jump-latest" onClick={jumpToLatest}>
          <Icon name="arrowDown" size={13} />
          {t("agent.jumpToLatest")}
        </button>
      )}

      <div className="composer">
        {suggestions.length > 0 && (
          <div className="composer-suggestions popover" role="listbox">
            {suggestions.map((s, i) => (
              <button
                key={s.value}
                role="option"
                aria-selected={i === activeSuggestion}
                className={`composer-suggestion${i === activeSuggestion ? " active" : ""}`}
                onMouseEnter={() => setActiveSuggestion(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(s);
                }}
              >
                <Icon name={s.kind === "command" ? "command" : "file"} size={13} />
                <bdi className="value" dir="ltr">
                  {s.value}
                </bdi>
                {s.detail && <span className="detail">{s.detail}</span>}
              </button>
            ))}
          </div>
        )}
        <div className={`composer-box${busy ? " busy" : ""}`}>
          <textarea
            ref={inputRef}
            rows={1}
            dir="auto"
            placeholder={busy ? t("agent.placeholderBusy") : t("agent.placeholder")}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart);
              setSuggestionsDismissed(false);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            aria-label={t("agent.placeholder")}
          />
          <div className="composer-bar">
            <span className="composer-hint">
              {agent.queue.length > 0 && `${t("agent.queued")}: ${agent.queue.length}`}
            </span>
            {busy && (
              <button className="btn danger small" onClick={agent.cancel}>
                <Icon name="stop" size={12} />
                {t("agent.stop")}
              </button>
            )}
            <button className="btn primary small" onClick={submit} disabled={!input.trim()} title={t("agent.send")}>
              <Icon name="send" size={13} flipRtl />
              {t("agent.send")}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
