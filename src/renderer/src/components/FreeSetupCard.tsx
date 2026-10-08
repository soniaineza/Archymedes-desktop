import { useEffect, useState } from "react";
import type { FreeKeyCheck } from "@shared/types";
import { OPENROUTER_KEYS_URL } from "@shared/model-catalog";
import { Icon } from "./Icon";
import type { KeyVerdict } from "../lib/free-key";
import { useI18n } from "../i18n/I18nProvider";


interface Props {
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  /** Reported on every change, so the parent can allow saving only after a test (or "Save anyway"). */
  onVerdictChange?: (verdict: KeyVerdict) => void;
  /** False when the key is the one already saved: no test is needed to keep it. */
  needsTest?: boolean;
  /** Field id for the key input (labels and tests find it by this). */
  inputId?: string;
}

/**
 * Free mode setup: what free mode is, where to get a free OpenRouter key, one key field and a live
 * test of the key. The test runs in the main process; the key never leaves it except to OpenRouter.
 */
export function FreeSetupCard({
  apiKey,
  onApiKeyChange,
  onVerdictChange,
  needsTest = true,
  inputId = "free-api-key",
}: Props) {
  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);
  const [verdict, setVerdict] = useState<KeyVerdict>("untested");
  const [result, setResult] = useState<FreeKeyCheck | null>(null);

  const report = (next: KeyVerdict): void => {
    setVerdict(next);
    onVerdictChange?.(next);
  };

  // A different key needs a new test.
  useEffect(() => {
    setResult(null);
    setVerdict("untested");
    onVerdictChange?.("untested");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const test = async (): Promise<void> => {
    report("testing");
    try {
      const checked = await window.archymedes.checkFreeKey(apiKey.trim());
      setResult(checked);
      report(checked.ok ? "works" : "failed");
    } catch {
      setResult({ ok: false, reason: "network" });
      report("failed");
    }
  };

  const failureText = (check: FreeKeyCheck): string => {
    if (check.ok) return "";
    switch (check.reason) {
      case "empty":
        return t("free.keyEmpty");
      case "invalid-key":
        return t("free.keyInvalid");
      case "rate-limited":
        return t("free.keyRateLimited");
      case "network":
        return t("free.keyNetwork");
      default:
        return t("free.keyServer", { status: check.status ?? 0 });
    }
  };

  const successText = (check: FreeKeyCheck): string => {
    if (!check.ok) return "";
    const limit = check.info.dailyRequestLimit;
    if (limit === undefined) return t("free.keyWorks");
    return check.info.isFreeTier
      ? t("free.keyWorksFreeTier", { limit })
      : t("free.keyWorksLimit", { limit });
  };

  return (
    <section className="free-setup" aria-labelledby={`${inputId}-title`}>
      <div className="free-setup-head">
        <Icon name="sparkles" size={16} />
        <h3 id={`${inputId}-title`}>{t("free.title")}</h3>
      </div>
      <p className="free-setup-text">{t("free.intro")}</p>
      <div className="free-setup-actions">
        <button
          className="btn small"
          type="button"
          onClick={() => void window.archymedes.openExternal(OPENROUTER_KEYS_URL)}
        >
          <Icon name="external" size={13} />
          {t("free.getKey")}
        </button>
      </div>
      <label className="field-label" htmlFor={inputId}>
        {t("free.keyLabel")}
      </label>
      <div className="input-group">
        <input
          id={inputId}
          className="input mono"
          dir="ltr"
          type={showKey ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          placeholder="sk-or-v1-…"
          onChange={(e) => onApiKeyChange(e.target.value)}
        />
        <button
          className="icon-btn"
          type="button"
          onClick={() => setShowKey((v) => !v)}
          aria-label={showKey ? t("settings.hideKey") : t("settings.showKey")}
          title={showKey ? t("settings.hideKey") : t("settings.showKey")}
        >
          <Icon name={showKey ? "eyeOff" : "eye"} size={15} />
        </button>
        <button
          className="btn small"
          type="button"
          onClick={() => void test()}
          disabled={!apiKey.trim() || verdict === "testing"}
        >
          {verdict === "testing" && <Icon name="loader" size={13} className="spin" />}
          {t("free.testKey")}
        </button>
      </div>
      {result?.ok && (
        <div className="free-setup-result ok" role="status">
          <Icon name="check" size={14} />
          <span>{successText(result)}</span>
        </div>
      )}
      {result && !result.ok && (
        <div className="free-setup-result failed" role="alert">
          <Icon name="alert" size={14} />
          <span>{failureText(result)}</span>
        </div>
      )}
      {needsTest && apiKey.trim() && (verdict === "untested" || verdict === "failed") && (
        <div className="free-setup-anyway">
          <span className="field-hint">{t("free.testFirst")}</span>
          <button className="link-btn" type="button" onClick={() => report("save-anyway")}>
            {t("free.saveAnyway")}
          </button>
        </div>
      )}
      {verdict === "save-anyway" && <div className="field-hint">{t("free.saveAnywayNote")}</div>}
      <div className="field-hint">{t("free.keyStored")}</div>
    </section>
  );
}
