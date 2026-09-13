import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  findLocale,
  formatCompact,
  formatCost,
  formatNumber,
  formatRelativeTime,
  matchLocale,
  translate,
} from "./core";
import type { MessageKey, Params } from "./types";

const STORAGE_KEY = "archymedes.locale";
export const SYSTEM_LOCALE = "system";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export function systemLocale(): string {
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

function readPreference(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && (stored === SYSTEM_LOCALE || findLocale(stored)) ? stored : SYSTEM_LOCALE;
  } catch {
    return SYSTEM_LOCALE;
  }
}

export interface I18nValue {
  /** "system" or a locale code. */
  preference: string;
  /** The resolved locale in use. */
  locale: string;
  dir: "ltr" | "rtl";
  setPreference: (preference: string) => void;
  t: (key: MessageKey, params?: Params) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCompact: (value: number) => string;
  formatCost: (micros: number, currency: string) => string;
  formatRelativeTime: (timestamp: number) => string;
  /** "mod+shift+p" → "Ctrl+Shift+P", "Strg+Umschalt+P" or "⌘⇧P". */
  shortcut: (spec: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readPreference);
  const locale = preference === SYSTEM_LOCALE ? systemLocale() : preference;
  const dir = findLocale(locale)?.dir ?? "ltr";

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const setPreference = useCallback((next: string) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable; the choice lasts for this session only
    }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const t = (key: MessageKey, params?: Params) => translate(locale, key, params);
    const keyLabels: Record<string, string> = IS_MAC
      ? { mod: "⌘", shift: "⇧", alt: "⌥" }
      : { mod: t("key.ctrl"), shift: t("key.shift"), alt: t("key.alt") };
    return {
      preference,
      locale,
      dir,
      setPreference,
      t,
      formatNumber: (n, options) => formatNumber(locale, n, options),
      formatCompact: (n) => formatCompact(locale, n),
      formatCost: (micros, currency) => formatCost(locale, micros, currency),
      formatRelativeTime: (ts) => formatRelativeTime(locale, ts),
      shortcut: (spec) =>
        spec
          .split("+")
          .map((part) => keyLabels[part] ?? (part.length === 1 ? part.toUpperCase() : part))
          .join(IS_MAC ? "" : "+"),
    };
  }, [dir, locale, preference, setPreference]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}
