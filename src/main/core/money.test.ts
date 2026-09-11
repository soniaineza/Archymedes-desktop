import { describe, expect, it } from "vitest";
import { addMoney, formatMoney, fromUnits, money, priceUsage, tokenPrices } from "./money";

describe("money", () => {
  it("rounds fractional micros to the nearest integer", () => {
    expect(money(1.4, "USD").micros).toBe(1);
    expect(money(1.6, "USD").micros).toBe(2);
  });

  it("rejects non-finite amounts", () => {
    expect(() => money(NaN, "USD")).toThrow();
    expect(() => money(Infinity, "USD")).toThrow();
  });

  it("converts between units and micros", () => {
    expect(fromUnits(1.5, "USD").micros).toBe(1_500_000);
  });

  it("adds money of the same currency", () => {
    expect(addMoney(fromUnits(1, "USD"), fromUnits(2, "USD")).micros).toBe(3_000_000);
  });

  it("refuses to add different currencies", () => {
    expect(() => addMoney(fromUnits(1, "USD"), fromUnits(1, "EUR"))).toThrow();
  });

  it("formats USD with a leading symbol and no space", () => {
    expect(formatMoney(fromUnits(1.5, "USD"))).toBe("$1.50");
  });

  it("formats very small USD amounts with extra precision", () => {
    expect(formatMoney(fromUnits(0.0042, "USD"))).toBe("$0.0042");
  });
});

describe("priceUsage", () => {
  const prices = tokenPrices("USD", 3, 15, 0.3);

  it("prices input and output tokens independently", () => {
    const cost = priceUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, prices);
    expect(cost.micros).toBe(18_000_000); // $3 input + $15 output
  });

  it("treats cached tokens as a subset of input, not an addition", () => {
    const cost = priceUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, prices);
    expect(cost.micros).toBe(300_000); // fully cached at $0.30/M, no uncached-input charge
  });

  it("clamps cachedInputTokens above inputTokens instead of overcounting", () => {
    const cost = priceUsage({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 1_000_000 }, prices);
    // cached is clamped to 100 (all of input), uncached is 0
    expect(cost.micros).toBe(Math.round((100 * prices.cachedInputPerMillion!) / 1_000_000));
  });

  it("applies the large-context multiplier above the threshold", () => {
    const tiered = tokenPrices("USD", 3, 15, undefined, {
      aboveInputTokens: 100,
      inputMultiplier: 2,
      outputMultiplier: 2,
    });
    const under = priceUsage({ inputTokens: 100, outputTokens: 0 }, tiered);
    const over = priceUsage({ inputTokens: 101, outputTokens: 0 }, tiered);
    expect(over.micros).toBe(2 * ((101 * tiered.inputPerMillion) / 1_000_000));
    expect(under.micros).toBe((100 * tiered.inputPerMillion) / 1_000_000);
  });
});
