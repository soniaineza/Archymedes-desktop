import { Icon } from "./Icon";
import { SYSTEM_LOCALE, systemLocale, useI18n } from "../i18n/I18nProvider";
import { findLocale } from "../i18n/core";
import { LOCALES } from "../i18n/locales";

export function LanguageSelect({ id, compact }: { id?: string; compact?: boolean }) {
  const { t, preference, setPreference } = useI18n();
  const systemName = findLocale(systemLocale())?.name ?? "English";

  return (
    <span className={`select-with-icon${compact ? " compact" : ""}`} title={t("titlebar.language")}>
      <Icon name="globe" size={14} />
      <select id={id} value={preference} onChange={(e) => setPreference(e.target.value)} aria-label={t("titlebar.language")}>
        <option value={SYSTEM_LOCALE}>{t("settings.languageSystem", { name: systemName })}</option>
        {LOCALES.map((locale) => (
          <option key={locale.code} value={locale.code} lang={locale.code}>
            {locale.name}
          </option>
        ))}
      </select>
    </span>
  );
}
