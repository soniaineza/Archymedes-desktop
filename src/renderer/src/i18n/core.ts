import { LOCALES } from "./locales";
import { en } from "./locales/en";
import type { LocaleInfo, Message, MessageKey, Params } from "./types";

/** Framework-free i18n primitives: locale matching, messages, and Intl formatting. */

export const DEFAULT_LOCALE = "en";

export function findLocale(code: string): LocaleInfo | undefined {
  return LOCALES.find((l) => l.code === code);
}

/** Best supported locale for a list of BCP 47 preferences, e.g. navigator.languages. */
export function matchLocale(preferred: readonly string[]): string {
  for (const pref of preferred) {
    const lower = pref.toLowerCase();
    const exact = LOCALES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;
    const base = lower.split("-")[0];
    const sameLanguage = LOCALES.find((l) => l.code.toLowerCase().split("-")[0] === base);
    if (sameLanguage) return sameLanguage.code;
  }
  return DEFAULT_LOCALE;
}

export function interpolate(template: string, params: Params | undefined, locale: string): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value;
  });
}

export function selectMessage(message: Message, locale: string, count: number | undefined): string {
  if (typeof message === "string") return message;
  if (count === undefined) return message.other;
  const category = new Intl.PluralRules(locale).select(count);
  return (category !== "other" ? message[category] : undefined) ?? message.other;
}

export function translate(locale: string, key: MessageKey, params?: Params): string {
  const message = findLocale(locale)?.messages[key] ?? en[key];
  const count = typeof params?.count === "number" ? params.count : undefined;
  return interpolate(selectMessage(message, locale, count), params, locale);
}

// ---------- Intl formatting ----------

export function formatNumber(locale: string, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** 1234 → "1.2K" / "1,2 k" / "1234" depending on locale. */
export function formatCompact(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Money in micros, formatted with the locale's conventions; sub-cent amounts keep two significant digits. */
export function formatCost(locale: string, micros: number, currency: string): string {
  const units = micros / 1_000_000;
  const standard = new Intl.NumberFormat(locale, { style: "currency", currency });
  const fractionDigits = standard.resolvedOptions().maximumFractionDigits ?? 2;
  if (units !== 0 && Math.abs(units) < 10 ** -fractionDigits) {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumSignificantDigits: 2 }).format(units);
  }
  return standard.format(units);
}

export function formatRelativeTime(locale: string, timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(timestamp);
}

export function currencyName(locale: string, code: string): string {
  try {
    return new Intl.DisplayNames(locale, { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function listCurrencies(): string[] {
  try {
    return Intl.supportedValuesOf("currency");
  } catch {
    return ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "BRL", "RWF", "KES", "NGN", "ZAR"];
  }
}
