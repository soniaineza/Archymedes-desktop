import { PRICE_CATALOG_CURRENCY } from "@shared/types";
import type { AgentStatus, CostInfo, GitInfo } from "@shared/types";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";
import { useDailyUsage } from "../lib/useDailyUsage";
import "../token-meter.css";

interface Props {
  status: AgentStatus;
  usage: CostInfo | null;
  git: GitInfo;
  workspaceName: string;
  onOpenPalette: () => void;
}

/** HH:MM of an ISO time, in UTC (the allowance resets at a UTC instant). */
function utcTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(11, 16) : "00:00";
}

export function StatusBar({ status, usage, git, workspaceName, onOpenPalette }: Props) {
  const { t, formatCompact, formatCost, formatNumber, shortcut } = useI18n();
  const busy = status !== "idle" && status !== "error";
  // Free mode's daily figures; refetched when a run settles, since settings may have changed.
  const daily = useDailyUsage(busy);
  const free = daily?.provider === "free";
  const allowance = free ? daily?.allowance : undefined;
  const tokensLeft = allowance?.remainingTokens;
  const allowanceTone = tokensLeft === undefined ? "" : tokensLeft <= 0 ? " allowance-out" : allowance?.warning ? " allowance-warn" : "";
  // Requests left today: the gateway's header, or OpenRouter's count for the user's own key.
  const keyInfo = free ? daily?.keyInfo : undefined;
  const requestsLeft = allowance?.remainingRequests ?? keyInfo?.dailyRequestsRemaining;
  const requestLimit = keyInfo?.dailyRequestLimit;
  const requestsTone =
    requestsLeft === undefined ? "" : requestsLeft <= 0 ? " allowance-out" : requestLimit && requestsLeft <= requestLimit * 0.1 ? " allowance-warn" : "";
  const requestsTitle = allowance?.remainingRequests !== undefined ? t("status.requestsGatewayTitle") : t("status.requestsKeyTitle");

  // Context meter: last turn's prompt vs the model's window (when known).
  const contextPct =
    usage?.contextTokens && usage?.contextLimit ? Math.min(100, (usage.contextTokens / usage.contextLimit) * 100) : null;
  const contextTone = contextPct === null ? "" : contextPct >= 85 ? " hot" : contextPct >= 60 ? " warm" : "";

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

      {free && daily && (
        <span className="seg" title={t("status.todayTitle", { date: daily.date })}>
          {t("status.today", { tokens: formatCompact(daily.tokens) })}
        </span>
      )}
      {requestsLeft !== undefined ? (
        <span className={`seg${requestsTone}`} title={requestsTitle}>
          <bdi dir="ltr">{t("status.requestsLeft", { count: requestsLeft })}</bdi>
        </span>
      ) : (
        requestLimit !== undefined && (
          <span className="seg" title={t("status.requestsKeyTitle")}>
            {keyInfo?.isFreeTier ? t("status.freeTierLimit", { limit: requestLimit }) : t("status.keyLimit", { limit: requestLimit })}
          </span>
        )
      )}
      {allowance && tokensLeft !== undefined && (
        <span
          className={`seg${allowanceTone}`}
          title={allowance.warning ? `${allowance.warning}\n${t("status.allowanceTitle")}` : t("status.allowanceTitle")}
        >
          <bdi dir="ltr">
            {t("status.allowanceLeft", {
              tokens: formatCompact(tokensLeft),
              time: allowance.resetUtc ? utcTime(allowance.resetUtc) : "00:00",
            })}
          </bdi>
        </span>
      )}
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
      {usage && contextPct !== null && (
        <span className="seg" title={t("status.context", { used: usage.contextTokens ?? 0, limit: usage.contextLimit ?? 0 })}>
          <span className="context-meter" role="img">
            <span className={`context-fill${contextTone}`} style={{ width: `${Math.max(3, contextPct)}%` }} />
          </span>
          {formatNumber(Math.round(contextPct), { style: "percent", maximumFractionDigits: 0 })}
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
