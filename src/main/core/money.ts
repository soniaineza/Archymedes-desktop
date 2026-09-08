/**
 * Money in micros — ported from archymedes-cli packages/core/src/money.ts.
 * Amounts are integers in millionths of a major unit, so a request costing a
 * fraction of a cent is never lost to float rounding.
 */

export type Currency = string;

export const MICROS_PER_UNIT = 1_000_000;

export type Money = { micros: number; currency: Currency };

export function money(micros: number, currency: Currency): Money {
  if (!Number.isFinite(micros)) throw new Error("Money amount must be a finite number");
  return { micros: Math.round(micros), currency };
}

export function fromUnits(units: number, currency: Currency): Money {
  return money(units * MICROS_PER_UNIT, currency);
}

export function toUnits(value: Money): number {
  return value.micros / MICROS_PER_UNIT;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Cannot add ${a.currency} and ${b.currency}`);
  return money(a.micros + b.micros, a.currency);
}

const FORMATS: Record<string, { symbol: string; min: number; max: number; smallThreshold: number; smallDigits: number }> = {
  USD: { symbol: "$", min: 2, max: 2, smallThreshold: 0.01, smallDigits: 4 },
  RWF: { symbol: "RWF", min: 0, max: 0, smallThreshold: 0, smallDigits: 0 },
  EUR: { symbol: "€", min: 2, max: 2, smallThreshold: 0.01, smallDigits: 4 },
};

export function formatMoney(value: Money): string {
  const format = FORMATS[value.currency];
  const units = toUnits(value);
  const magnitude = Math.abs(units);
  if (!format) {
    const digits = magnitude > 0 && magnitude < 0.01 ? 4 : 2;
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: value.currency, currencyDisplay: "narrowSymbol",
      minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits,
    }).format(units);
  }
  const digits = magnitude > 0 && magnitude < format.smallThreshold ? format.smallDigits : format.max;
  const rendered = units.toLocaleString("en-US", { minimumFractionDigits: Math.min(format.min, digits), maximumFractionDigits: digits });
  return value.currency === "USD" ? `${format.symbol}${rendered}` : `${format.symbol} ${rendered}`;
}

/** Price of a model's tokens, in the currency the provider publishes. */
export type TokenPrices = {
  currency: Currency;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  largeContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number };
};

export function tokenPrices(currency: Currency, input: number, output: number, cachedInput?: number, largeContext?: TokenPrices["largeContext"]): TokenPrices {
  return {
    currency,
    inputPerMillion: Math.round(input * MICROS_PER_UNIT),
    outputPerMillion: Math.round(output * MICROS_PER_UNIT),
    ...(cachedInput !== undefined ? { cachedInputPerMillion: Math.round(cachedInput * MICROS_PER_UNIT) } : {}),
    ...(largeContext ? { largeContext } : {}),
  };
}

export type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

/** What a request cost. Cached tokens are a subset of input, never an addition. */
export function priceUsage(usage: TokenUsage, prices: TokenPrices): Money {
  const tier = prices.largeContext && usage.inputTokens > prices.largeContext.aboveInputTokens ? prices.largeContext : undefined;
  const inputMultiplier = tier?.inputMultiplier ?? 1;
  const outputMultiplier = tier?.outputMultiplier ?? 1;
  const cached = prices.cachedInputPerMillion === undefined ? 0 : Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const micros =
    (uncached * prices.inputPerMillion * inputMultiplier) / 1_000_000 +
    (cached * (prices.cachedInputPerMillion ?? 0) * inputMultiplier) / 1_000_000 +
    (usage.outputTokens * prices.outputPerMillion * outputMultiplier) / 1_000_000;
  return money(micros, prices.currency);
}
