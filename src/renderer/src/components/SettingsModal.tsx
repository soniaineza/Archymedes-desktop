import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_PROVIDER_SETTINGS, PRICE_CATALOG_CURRENCY, TERMINAL_SHELL_CHOICES } from "@shared/types";
import type { CommandApprovalMode, ProviderSettings, TerminalShellChoice } from "@shared/types";
import { PROVIDER_IDS, PROVIDER_INFO } from "@shared/providers";
import type { ProviderId } from "@shared/providers";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { LanguageSelect } from "./LanguageSelect";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { useI18n } from "../i18n/I18nProvider";
import { currencyName, listCurrencies } from "../i18n/core";
import { LOCALES } from "../i18n/locales";
import type { MessageKey } from "../i18n/types";
import { THEMES } from "../lib/theme";
import type { ResolvedTheme, Theme } from "../lib/theme";

interface Props {
  theme: Theme;
  scale: number;
  onThemeChange: (theme: Theme) => void;
  onScaleChange: (scale: number) => void;
  onClose: () => void;
  onSaved: (settings: ProviderSettings) => void;
}

type Tab = "general" | "appearance" | "provider" | "costs" | "terminal";

const TABS: readonly { id: Tab; icon: IconName; label: MessageKey }[] = [
  { id: "general", icon: "sliders", label: "settings.tab.general" },
  { id: "appearance", icon: "palette", label: "settings.tab.appearance" },
  { id: "provider", icon: "cpu", label: "settings.tab.provider" },
  { id: "costs", icon: "coins", label: "settings.tab.costs" },
  { id: "terminal", icon: "terminal", label: "settings.tab.terminal" },
];

/** Settings choice → the same labels the terminal + menu uses. */
const SHELL_LABEL_KEY: Record<TerminalShellChoice, MessageKey> = {
  default: "terminal.shellDefault",
  powershell: "terminal.shellPowershell",
  cmd: "terminal.shellCmd",
  gitbash: "terminal.shellGitBash",
  custom: "terminal.shellCustom",
};

const UI_SCALES = [0.9, 1, 1.1, 1.25];

/** Background, panel, text, accent. */
const THEME_PREVIEW: Record<ResolvedTheme, [string, string, string, string]> = {
  dark: ["#0b0b0d", "#16161a", "#e6e6e9", "#8ab4f8"],
  light: ["#f6f6f7", "#ffffff", "#1c1c21", "#2563eb"],
  "solarized-dark": ["#002b36", "#073642", "#93a1a1", "#268bd2"],
  "solarized-light": ["#fdf6e3", "#eee8d5", "#586e75", "#268bd2"],
  "high-contrast": ["#000000", "#111111", "#ffffff", "#41a8ff"],
};

function Swatch({ theme }: { theme: ResolvedTheme }) {
  const [bg, panel, text, accent] = THEME_PREVIEW[theme];
  return (
    <span className="swatch" style={{ background: bg }}>
      <span className="swatch-side" style={{ background: panel }} />
      <span className="swatch-lines">
        <span style={{ background: text }} />
        <span style={{ background: text, opacity: 0.5 }} />
        <span style={{ background: accent }} />
      </span>
    </span>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function SettingsModal({ theme, scale, onThemeChange, onScaleChange, onClose, onSaved }: Props) {
  const { t, locale, formatNumber, formatCost } = useI18n();
  const notify = useToast();
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [rateText, setRateText] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.archymedes.getSettings().then((loaded) => {
      setSettings(loaded);
      setRateText(loaded.exchangeRate > 0 ? String(loaded.exchangeRate) : "");
    });
  }, []);

  const currencies = useMemo(
    () =>
      listCurrencies()
        .map((code) => ({ code, name: currencyName(locale, code) }))
        .sort((a, b) =>
          a.code === PRICE_CATALOG_CURRENCY ? -1 : b.code === PRICE_CATALOG_CURRENCY ? 1 : a.name.localeCompare(b.name, locale),
        ),
    [locale],
  );

  const update = <K extends keyof ProviderSettings>(key: K, value: ProviderSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const pickProvider = (id: ProviderId) =>
    setSettings((s) => ({ ...s, provider: id, model: PROVIDER_INFO[id].defaultModel, baseUrl: PROVIDER_INFO[id].defaultBaseUrl ?? "" }));

  // Accept both "1450.5" and the decimal comma many locales type: "1450,5".
  const parsedRate = Number(rateText.trim().replace(",", "."));
  const rateValid = rateText.trim() === "" || (Number.isFinite(parsedRate) && parsedRate > 0);
  const needsRate = settings.currency !== PRICE_CATALOG_CURRENCY;

  const save = async () => {
    const next: ProviderSettings = {
      ...settings,
      exchangeRate: needsRate && rateText.trim() ? parsedRate : 0,
      maxIterations: Math.min(200, Math.max(1, Math.round(settings.maxIterations) || 1)),
    };
    setSaving(true);
    try {
      await window.archymedes.saveSettings(next);
      onSaved(next);
      notify(t("settings.saved"), "success");
      onClose();
    } catch (err) {
      notify(t("common.error", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setSaving(false);
    }
  };

  const providerHint =
    settings.provider === "anthropic"
      ? t("settings.providerAnthropic")
      : settings.provider === "ollama"
        ? t("settings.providerOllama")
        : settings.provider === "free"
          ? t("settings.providerFree")
          : t("settings.providerCompat");

  return (
    <Modal onClose={onClose} labelledBy="settings-title" className="settings-modal">
      <div className="modal-header">
        <h2 id="settings-title">{t("settings.title")}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-orientation="vertical">
          {TABS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={`settings-tab${tab === item.id ? " active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={15} />
              <span>{t(item.label)}</span>
            </button>
          ))}
        </div>

        <div className="settings-content" role="tabpanel">
          {tab === "general" && (
            <>
              <Field label={t("settings.language")} hint={t("settings.languageHint")} htmlFor="ui-language">
                <LanguageSelect id="ui-language" />
              </Field>
              <Field label={t("settings.responseLanguage")} hint={t("settings.responseLanguageHint")} htmlFor="reply-language">
                <select
                  id="reply-language"
                  className="input"
                  value={settings.responseLanguage}
                  onChange={(e) => update("responseLanguage", e.target.value)}
                >
                  <option value="">{t("settings.responseLanguageAuto")}</option>
                  {LOCALES.map((l) => (
                    <option key={l.code} value={l.englishName} lang={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("settings.scale")}>
                <div className="segmented" role="radiogroup" aria-label={t("settings.scale")}>
                  {UI_SCALES.map((value) => (
                    <button
                      key={value}
                      role="radio"
                      aria-checked={scale === value}
                      className={scale === value ? "active" : ""}
                      onClick={() => onScaleChange(value)}
                    >
                      {formatNumber(value, { style: "percent" })}
                    </button>
                  ))}
                </div>
              </Field>
            </>
          )}

          {tab === "appearance" && (
            <Field label={t("settings.theme")} hint={t("settings.themeHint")}>
              <div className="theme-grid" role="radiogroup" aria-label={t("settings.theme")}>
                {THEMES.map((id) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={theme === id}
                    className={`theme-card${theme === id ? " active" : ""}`}
                    onClick={() => onThemeChange(id)}
                  >
                    {id === "system" ? (
                      <span className="theme-preview split">
                        <Swatch theme="light" />
                        <Swatch theme="dark" />
                      </span>
                    ) : (
                      <span className="theme-preview">
                        <Swatch theme={id} />
                      </span>
                    )}
                    <span className="theme-card-label">
                      {theme === id && <Icon name="check" size={13} />}
                      {t(`theme.${id}`)}
                    </span>
                  </button>
                ))}
              </div>
            </Field>
          )}

          {tab === "provider" && (
            <>
              <Field label={t("settings.provider")} hint={providerHint} htmlFor="provider">
                <select
                  id="provider"
                  className="input"
                  value={settings.provider}
                  onChange={(e) => pickProvider(e.target.value as ProviderId)}
                >
                  {PROVIDER_IDS.map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_INFO[id].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("settings.model")} hint={t("settings.modelHint")} htmlFor="model">
                <input
                  id="model"
                  className="input mono"
                  dir="ltr"
                  spellCheck={false}
                  value={settings.model}
                  placeholder={PROVIDER_INFO[settings.provider]?.defaultModel}
                  onChange={(e) => update("model", e.target.value)}
                />
              </Field>
              <Field label={t("settings.apiKey")} htmlFor="api-key">
                <div className="input-group">
                  <input
                    id="api-key"
                    className="input mono"
                    dir="ltr"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={settings.apiKey}
                    placeholder={
                      PROVIDER_INFO[settings.provider]?.requiresApiKey === false
                        ? t("settings.apiKeyNotRequired")
                        : t("settings.apiKeyPlaceholder")
                    }
                    onChange={(e) => update("apiKey", e.target.value)}
                  />
                  <button
                    className="icon-btn"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? t("settings.hideKey") : t("settings.showKey")}
                    title={showKey ? t("settings.hideKey") : t("settings.showKey")}
                  >
                    <Icon name={showKey ? "eyeOff" : "eye"} size={15} />
                  </button>
                </div>
              </Field>
              <Field label={t("settings.baseUrl")} htmlFor="base-url">
                <input
                  id="base-url"
                  className="input mono"
                  dir="ltr"
                  spellCheck={false}
                  value={settings.baseUrl}
                  placeholder={PROVIDER_INFO[settings.provider]?.defaultBaseUrl ?? t("settings.baseUrlPlaceholder")}
                  onChange={(e) => update("baseUrl", e.target.value)}
                />
              </Field>
              <Field label={t("settings.commandApproval")} hint={t("settings.commandApprovalHint")} htmlFor="command-approval">
                <select
                  id="command-approval"
                  className="input"
                  value={settings.commandApproval}
                  onChange={(e) => update("commandApproval", e.target.value as CommandApprovalMode)}
                >
                  <option value="ask">{t("settings.commandApprovalAsk")}</option>
                  <option value="auto">{t("settings.commandApprovalAuto")}</option>
                </select>
              </Field>
              <Field label={t("settings.maxIterations")} hint={t("settings.maxIterationsHint")} htmlFor="max-iterations">
                <input
                  id="max-iterations"
                  className="input narrow"
                  type="number"
                  min={1}
                  max={200}
                  value={settings.maxIterations}
                  onChange={(e) => update("maxIterations", Number(e.target.value))}
                />
              </Field>
              <div className="callout info">
                <Icon name="info" size={15} />
                <span>{t("settings.keyPrivacy")}</span>
              </div>
            </>
          )}

          {tab === "terminal" && (
            <>
              <Field label={t("terminal.shellLabel")} hint={t("terminal.shellHint")} htmlFor="terminal-shell">
                <select
                  id="terminal-shell"
                  className="input"
                  value={settings.terminalShell}
                  onChange={(e) => update("terminalShell", e.target.value as TerminalShellChoice)}
                >
                  {TERMINAL_SHELL_CHOICES.map((choice) => (
                    <option key={choice} value={choice}>
                      {t(SHELL_LABEL_KEY[choice])}
                    </option>
                  ))}
                </select>
              </Field>
              {settings.terminalShell === "custom" && (
                <Field label={t("terminal.customPath")} htmlFor="terminal-shell-path">
                  <input
                    id="terminal-shell-path"
                    className="input mono"
                    dir="ltr"
                    spellCheck={false}
                    placeholder={process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/zsh"}
                    value={settings.terminalShellPath}
                    onChange={(e) => update("terminalShellPath", e.target.value)}
                  />
                </Field>
              )}
            </>
          )}

          {tab === "costs" && (
            <>
              <Field label={t("settings.currency")} htmlFor="currency">
                <select id="currency" className="input" value={settings.currency} onChange={(e) => update("currency", e.target.value)}>
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              {needsRate && (
                <Field
                  label={t("settings.exchangeRate", { base: PRICE_CATALOG_CURRENCY, currency: settings.currency })}
                  hint={t("settings.exchangeRateHint", { base: PRICE_CATALOG_CURRENCY, currency: settings.currency })}
                  htmlFor="exchange-rate"
                >
                  <div className="rate-row">
                    <input
                      id="exchange-rate"
                      className={`input narrow mono${rateValid ? "" : " invalid"}`}
                      dir="ltr"
                      inputMode="decimal"
                      value={rateText}
                      aria-invalid={!rateValid}
                      onChange={(e) => setRateText(e.target.value)}
                    />
                    {rateValid && rateText.trim() && (
                      <span className="rate-preview">
                        {formatCost(1_000_000, PRICE_CATALOG_CURRENCY)} ≈ {formatCost(1_000_000 * parsedRate, settings.currency)}
                      </span>
                    )}
                  </div>
                </Field>
              )}
              <div className="callout info">
                <Icon name="info" size={15} />
                <span>{t("settings.pricingHint")}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="modal-footer">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={saving || !rateValid}>
          {t("common.save")}
        </button>
      </div>
    </Modal>
  );
}
