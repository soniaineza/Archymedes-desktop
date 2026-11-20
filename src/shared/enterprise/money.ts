import type { Money } from "./types";

/** ISO-4217-shaped code: three upper-case letters. */
export function isCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

/** Minor-unit exponent for a currency (USD 2, RWF 0, …). */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Parses "12,000.50", "$1,234.5" or "-3000" into integer minor units using
 * string arithmetic, so 0.1 becomes exactly 10. Returns null for anything that
 * is not a plain decimal or has more fraction digits than the currency allows.
 */
export function parseMoneyToMinor(text: string, digits = 2): number | null {
  const cleaned = text.trim().replace(/[\s,$€£]/g, "").replace(/^\((.*)\)$/, "-$1");
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  if (frac.length > digits) return null;
  const minor = Number(whole) * 10 ** digits + Number((frac + "0".repeat(digits)).slice(0, digits) || "0");
  if (!Number.isSafeInteger(minor)) return null;
  return sign === "-" ? -minor : minor;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  return { currency: a.currency, minor: a.minor + b.minor };
}

/** "$12,500", "−$1,800" (true minus sign), compact "$1.2M" when asked. */
export function formatMoney(minor: number, currency: string, opts: { compact?: boolean; signed?: boolean } = {}): string {
  const digits = minorDigits(currency);
  const major = Math.abs(minor) / 10 ** digits;
  // Cents only where they matter: small amounts that are not whole.
  const whole = Number.isInteger(major) || major >= 100;
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: opts.compact ? 1 : whole ? 0 : digits,
    minimumFractionDigits: 0,
  });
  const body = fmt.format(major);
  if (minor < 0) return `−${body}`;
  if (opts.signed && minor > 0) return `+${body}`;
  return body;
}

export function formatPct(p: number | null, digits = 0): string {
  return p === null ? "—" : `${(p * 100).toFixed(digits)}%`;
}
