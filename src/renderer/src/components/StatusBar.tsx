import { useEffect, useState } from "react";
import type { AgentStatus } from "@shared/types";

interface Props {
  status: AgentStatus;
  usage: { input: number; output: number; formatted?: string; unpriced?: boolean } | null;
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

  return (
    <div className="statusbar">
      <span className="seg accent-seg">{workspaceName}</span>
      <span className="seg">{branchPart}</span>
      <span className="spacer" />
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
