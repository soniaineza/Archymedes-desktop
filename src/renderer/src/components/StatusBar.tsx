import { useEffect, useState } from "react";
import { PRICE_CATALOG_CURRENCY } from "@shared/types";
import type { AgentStatus, CostInfo, GitInfo } from "@shared/types";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

/** Git state polled for the status bar. */
export function useGitStatus(workspace: string | null): GitInfo {
  const [git, setGit] = useState<GitInfo>({ isRepo: false, branch: "", dirtyCount: 0 });
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

interface Props {
  status: AgentStatus;
  usage: CostInfo | null;
  git: GitInfo;
  workspaceName: string;
  onOpenPalette: () => void;
}

export function StatusBar({ status, usage, git, workspaceName, onOpenPalette }: Props) {
  const { t, formatCompact, formatCost, formatNumber, shortcut } = useI18n();
  const busy = status !== "idle" && status !== "error";

  return (
    <footer className="statusbar">
      <span className="seg strong">
        <Icon name="folder" size={13} />
        <bdi>{workspaceName}</bdi>
      </span>
      <span className="seg" title={git.dirtyCount > 0 ? t("status.changes", { count: git.dirtyCount }) : undefined}>
        {git.isRepo ? (
          <>
            <Icon name="gitBranch" size={13} />
            <bdi>{git.branch}</bdi>
            {git.dirtyCount > 0 && <span className="count-badge">{formatNumber(git.dirtyCount)}</span>}
          </>
        ) : (
          t("status.noGit")
        )}
      </span>

      <span className="spacer" />

      {usage && (
        <span
          className="seg"
          title={t("status.tokens", { input: usage.inputTokens, output: usage.outputTokens, cached: usage.cachedInputTokens })}
        >
          <bdi dir="ltr">
            ↑{formatCompact(usage.inputTokens)} ↓{formatCompact(usage.outputTokens)}
          </bdi>
        </span>
      )}
      {usage && (
        <span
          className="seg"
          title={usage.converted ? t("status.converted", { currency: PRICE_CATALOG_CURRENCY }) : undefined}
        >
          <Icon name="coins" size={13} />
          {usage.unpriced
            ? t("status.unpriced")
            : `${usage.converted ? "≈ " : ""}${formatCost(usage.costMicros, usage.currency)}`}
        </span>
      )}

      <span className={`seg agent-state ${status}`} aria-live="polite">
        <span className={`state-dot${busy ? " pulse" : ""}`} />
        {t(`agent.status.${status}`)}
      </span>
      <button className="seg clickable" onClick={onOpenPalette}>
        <kbd>{shortcut("mod+shift+p")}</kbd>
        {t("status.commands")}
      </button>
    </footer>
  );
}
