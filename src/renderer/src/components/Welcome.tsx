import { lazy, Suspense, useState } from "react";
import type { ProviderSettings } from "@shared/types";
import { FreeSetupCard } from "./FreeSetupCard";
import { freeKeySavable } from "../lib/free-key";
import type { KeyVerdict } from "../lib/free-key";
import { Icon } from "./Icon";
import { useToast } from "./Toasts";
import { LanguageSelect } from "./LanguageSelect";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/types";
import { readRecent, removeRecent } from "../lib/recent";
import { themeIcon } from "../lib/theme";
import type { Theme } from "../lib/theme";

// three.js is large; load it only for the welcome screen, and never for reduced-motion users.
const HeroCanvas = lazy(() => import("./HeroCanvas").then((m) => ({ default: m.HeroCanvas })));

interface Props {
  theme: Theme;
  onPick: () => void;
  onOpenPath: (path: string) => void;
  onCycleTheme: () => void;
  /** Show the "Add your API key" step; false for keyless providers such as free mode (the default). */
  needsKey?: boolean;
  /** Free mode cannot run yet (no key, no gateway): show its setup card. */
  freeSetup?: boolean;
  /** Called with the saved settings after the setup card stored a key. */
  onSettingsSaved?: (settings: ProviderSettings) => void;
}

/** The free-mode setup card with its own Save, for the welcome screen (Settings is not open there). */
function WelcomeFreeSetup({ onSaved }: { onSaved?: (settings: ProviderSettings) => void }) {
  const { t } = useI18n();
  const notify = useToast();
  const [apiKey, setApiKey] = useState("");
  const [verdict, setVerdict] = useState<KeyVerdict>("untested");
  const [saving, setSaving] = useState(false);
  const canSave = Boolean(apiKey.trim()) && freeKeySavable(verdict, true, apiKey) && !saving;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const current = await window.archymedes.getSettings();
      const next: ProviderSettings = { ...current, provider: "free", apiKey: apiKey.trim() };
      await window.archymedes.saveSettings(next);
      notify(t("settings.saved"), "success");
      onSaved?.(next);
    } catch (err) {
      notify(t("common.error", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="welcome-free">
      <FreeSetupCard apiKey={apiKey} onApiKeyChange={setApiKey} onVerdictChange={setVerdict} inputId="welcome-free-key" />
      <div className="welcome-free-save">
        <button className="btn primary small" onClick={() => void save()} disabled={!canSave}>
          {t("free.saveKey")}
        </button>
      </div>
    </div>
  );
}

const OPEN_STEP: [MessageKey, MessageKey] = ["welcome.step1Title", "welcome.step1Desc"];
const KEY_STEP: [MessageKey, MessageKey] = ["welcome.step2Title", "welcome.step2Desc"];
const ASK_STEP: [MessageKey, MessageKey] = ["welcome.step3Title", "welcome.step3Desc"];

export function Welcome({ theme, onPick, onOpenPath, onCycleTheme, needsKey = false, freeSetup = false, onSettingsSaved }: Props) {
  const steps = needsKey ? [OPEN_STEP, KEY_STEP, ASK_STEP] : [OPEN_STEP, ASK_STEP];
  const { t, formatNumber } = useI18n();
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [animate] = useState(() => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const themeName = t(`theme.${theme}`);

  return (
    <div className="welcome">
      <div className="welcome-toolbar">
        <LanguageSelect compact />
        <button className="btn ghost small" onClick={onCycleTheme} title={t("titlebar.theme", { name: themeName })}>
          <Icon name={themeIcon(theme)} size={14} />
          {themeName}
        </button>
      </div>

      {animate && (
        <div className="hero-canvas-host" aria-hidden>
          <Suspense fallback={null}>
            <HeroCanvas />
          </Suspense>
        </div>
      )}

      <main className="welcome-content">
        <div className="wordmark">
          <Icon name="logo" size={34} />
          <h1>Archymedes</h1>
        </div>
        <p className="tagline">{t("welcome.tagline")}</p>

        <div className="welcome-actions">
          <button className="btn primary large" onClick={onPick} autoFocus>
            <Icon name="folder" size={16} />
            {t("welcome.openWorkspace")}
          </button>
        </div>

        {freeSetup && <WelcomeFreeSetup onSaved={onSettingsSaved} />}

        {recent.length > 0 && (
          <section className="recent" aria-label={t("welcome.recent")}>
            <div className="section-label">{t("welcome.recent")}</div>
            {recent.map((path) => (
              <div key={path} className="recent-item">
                <button className="recent-open" onClick={() => onOpenPath(path)} title={path}>
                  <Icon name="folder" size={15} />
                  <span className="recent-text">
                    <bdi className="name">{path.split(/[\\/]/).pop()}</bdi>
                    <bdi className="path" dir="ltr">
                      {path}
                    </bdi>
                  </span>
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setRecent(removeRecent(path))}
                  title={t("welcome.removeRecent")}
                  aria-label={t("welcome.removeRecent")}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </section>
        )}

        <ol className="steps">
          {steps.map(([title, desc], i) => (
            <li key={title} className="step">
              <span className="step-n">{formatNumber(i + 1)}</span>
              <div>
                <div className="step-title">{t(title)}</div>
                <div className="step-desc">{t(desc)}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="welcome-foot">{t("welcome.features")}</div>
      </main>
    </div>
  );
}
