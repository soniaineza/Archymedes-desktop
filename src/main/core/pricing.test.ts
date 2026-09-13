import { describe, expect, it } from "vitest";
import { priceAliases, selectPrice, validatePriceRecord, type PriceRecord } from "./pricing";

function record(overrides: Partial<PriceRecord> = {}): PriceRecord {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    modality: "text",
    currency: "USD",
    billingUnit: "tokens",
    per: 1_000_000,
    rates: { input: 3, output: 15 },
    source: "test",
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

describe("validatePriceRecord", () => {
  it("accepts a well-formed record", () => {
    expect(() => validatePriceRecord(record())).not.toThrow();
  });

  it("rejects a non-ISO effectiveFrom date", () => {
    expect(() => validatePriceRecord(record({ effectiveFrom: "Jan 1 2026" }))).toThrow();
  });

  it("rejects effectiveUntil at or before effectiveFrom", () => {
    expect(() =>
      validatePriceRecord(record({ effectiveFrom: "2026-01-01", effectiveUntil: "2026-01-01" })),
    ).toThrow();
  });

  it("rejects a non-positive per", () => {
    expect(() => validatePriceRecord(record({ per: 0 }))).toThrow();
  });

  it("rejects an empty rates map", () => {
    expect(() => validatePriceRecord(record({ rates: {} }))).toThrow();
  });
});

describe("priceAliases", () => {
  it("strips a dated snapshot suffix", () => {
    expect(priceAliases("claude-sonnet-5-20260115")).toEqual(["claude-sonnet-5-20260115", "claude-sonnet-5"]);
  });

  it("strips a -latest suffix", () => {
    expect(priceAliases("gpt-5-latest")).toEqual(["gpt-5-latest", "gpt-5"]);
  });

  it("leaves a plain model id alone", () => {
    expect(priceAliases("claude-sonnet-5")).toEqual(["claude-sonnet-5"]);
  });
});

describe("selectPrice", () => {
  const records = [
    record({ effectiveFrom: "2026-01-01", rates: { input: 3, output: 15 } }),
    record({ effectiveFrom: "2026-06-01", rates: { input: 2, output: 10 } }),
  ];

  it("picks the record in force on a given date", () => {
    expect(selectPrice(records, { provider: "anthropic", model: "claude-sonnet-5", asOf: "2026-03-01" })?.rates.input).toBe(3);
    expect(selectPrice(records, { provider: "anthropic", model: "claude-sonnet-5", asOf: "2026-09-01" })?.rates.input).toBe(2);
  });

  it("finds a dated alias via the base model's price", () => {
    const found = selectPrice(records, { provider: "anthropic", model: "claude-sonnet-5-20260701", asOf: "2026-09-01" });
    expect(found?.rates.input).toBe(2);
  });

  it("returns undefined for an unknown model", () => {
    expect(selectPrice(records, { provider: "anthropic", model: "nonexistent" })).toBeUndefined();
  });

  it("respects effectiveUntil boundaries", () => {
    const bounded = [record({ effectiveFrom: "2026-01-01", effectiveUntil: "2026-02-01" })];
    expect(selectPrice(bounded, { provider: "anthropic", model: "claude-sonnet-5", asOf: "2026-02-01" })).toBeUndefined();
    expect(selectPrice(bounded, { provider: "anthropic", model: "claude-sonnet-5", asOf: "2026-01-31" })).toBeDefined();
  });
});
