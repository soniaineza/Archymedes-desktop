import { useEffect, useState } from "react";
import type { AgentStatus } from "@shared/types";

interface Props {
  status: AgentStatus;
  usage: {
    input: number;
    output: number;
    formatted?: string;
    unpriced?: boolean;
    contextTokens?: number;
    contextLimit?: number;
  } | null;
  workspaceName: string;
}

/** A git state polled for the status bar. */
export function useGitStatus(workspace: string | null) {
  const [git, setGit] = useState({ isRepo: false, branch: "", dirtyCount: 0 });
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    const poll = () => {
      void window.archymedes.getGitInfo().then((info) => {
        if (alive) setGit(info);
      });
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workspace]);
  return git;
}

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "var(--green)",
  thinking: "var(--accent)",
  "calling-tool": "var(--accent)",
  "awaiting-model": "var(--blue)",
  error: "var(--red)",
};

export function StatusBar({ status, usage, git, workspaceName }: Props & {
  git: { isRepo: boolean; branch: string; dirtyCount: number };
}) {
  const branchPart = git.isRepo ? `⑂ ${git.branch}${git.dirtyCount > 0 ? ` ✎${git.dirtyCount}` : ""}` : "no git";

  // Context fill meter: how much of the model's window the conversation now
  // occupies. Turns green → yellow → red as it fills.
  let meter: JSX.Element | null = null;
  if (usage?.contextTokens && usage.contextLimit && usage.contextLimit > 0) {
    const pct = Math.min(100, (usage.contextTokens / usage.contextLimit) * 100);
    const color = pct > 85 ? "var(--red)" : pct > 60 ? "var(--blue)" : "var(--green)";
    const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
    meter = (
      <span
        className="seg"
        title={`~${fmt(usage.contextTokens)} of ${fmt(usage.contextLimit)} context tokens in use`}
      >
        <span className="meter-track">
          <span className="meter-fill" style={{ width: `${pct}%`, background: color }} />
        </span>
        {pct.toFixed(0)}%
      </span>
    );
  }

  return (
    <div className="statusbar">
      <span className="seg accent-seg">{workspaceName}</span>
      <span className="seg">{branchPart}</span>
      <span className="spacer" />
      {meter}
      <span className="seg" style={{ color: STATUS_COLORS[status] }}>
        ● {status}
      </span>
      {usage && (
        <span className="seg">
          ↑{usage.input >= 1000 ? `${(usage.input / 1000).toFixed(1)}k` : usage.input} ↓
          {usage.output >= 1000 ? `${(usage.output / 1000).toFixed(1)}k` : usage.output}
          {usage.formatted && (usage.unpriced ? " · unpriced" : ` · ${usage.formatted}`)}
        </span>
      )}
      <span className="seg dim">Ctrl+P palette · Ctrl+Shift+F search · Ctrl+` terminal · /help commands</span>
    </div>
  );
}
