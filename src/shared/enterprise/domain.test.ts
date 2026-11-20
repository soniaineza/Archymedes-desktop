import { describe, expect, it } from "vitest";
import { addMoney, formatMoney, parseMoneyToMinor } from "./money";
import { canTransition, nextStates } from "./workflow";
import { computeMetric, freshness, ratio } from "./metrics";
import { parseCsv, previewImport } from "./csv-import";
import { allocateInvoiceLines, brierScore, measureOutcome } from "./measurement";
import { advanceMoat, moatPotentialMinor } from "./moat";
import type { ImportMapping, SourceRow } from "./types";

describe("money", () => {
  it("parses decimal strings to integer minor units without float drift", () => {
    expect(parseMoneyToMinor("12,000.50")).toBe(1_200_050);
    expect(parseMoneyToMinor("0.1")).toBe(10);
    expect(parseMoneyToMinor("-3000")).toBe(-300_000);
    expect(parseMoneyToMinor("$1,234.5")).toBe(123_450);
    expect(parseMoneyToMinor("abc")).toBeNull();
    expect(parseMoneyToMinor("1.234")).toBeNull();
  });
  it("refuses to add different currencies", () => {
    expect(addMoney({ currency: "USD", minor: 1 }, { currency: "USD", minor: 2 })).toEqual({ currency: "USD", minor: 3 });
    expect(() => addMoney({ currency: "USD", minor: 1 }, { currency: "RWF", minor: 2 })).toThrow(/currency/i);
  });
  it("formats with currency and sign", () => {
    expect(formatMoney(-180_000, "USD")).toBe("−$1,800");
    expect(formatMoney(1_250_000, "USD")).toBe("$12,500");
  });
  it("shows cents only on small non-whole amounts", () => {
    expect(formatMoney(560_943, "USD")).toBe("$5,609");
    expect(formatMoney(1_234, "USD")).toBe("$12.34");
    expect(formatMoney(6_233, "USD", { signed: true })).toBe("+$62.33");
  });
});

describe("decision workflow", () => {
  it("allows the spec's lifecycle", () => {
    const path = ["Draft", "Evaluated", "AwaitingApproval", "Approved", "Executing", "DeliveryReview", "Measuring", "Debriefed"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });
  it("allows evidence loops and delivery rework", () => {
    expect(canTransition("Evaluated", "NeedsEvidence")).toBe(true);
    expect(canTransition("NeedsEvidence", "Draft")).toBe(true);
    expect(canTransition("DeliveryReview", "Executing")).toBe(true);
  });
  it("forbids skipping approval or measuring before delivery", () => {
    expect(canTransition("Evaluated", "Approved")).toBe(false);
    expect(canTransition("Draft", "Executing")).toBe(false);
    expect(canTransition("Executing", "Measuring")).toBe(false);
    expect(canTransition("Debriefed", "Draft")).toBe(false);
  });
  it("terminal states have no exits", () => {
    expect(nextStates("Debriefed")).toEqual([]);
    expect(nextStates("Cancelled")).toEqual([]);
  });
});

const rows: SourceRow[] = [
  { externalId: "a", occurredAt: "2026-10-01T00:00:00Z", currency: "USD", amountMinor: 1000, fields: { stage: "won", segment: "smb" } },
  { externalId: "b", occurredAt: "2026-10-02T00:00:00Z", currency: "USD", amountMinor: 3000, fields: { stage: "won", segment: "mid" } },
  { externalId: "c", occurredAt: "2026-10-03T00:00:00Z", currency: "USD", amountMinor: 0, fields: { stage: "lost", segment: "smb" } },
];
const window = { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" };

describe("metrics", () => {
  it("a zero denominator returns unknown with a reason, never NaN or Infinity", () => {
    const r = ratio(5, 0);
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.reason).toMatch(/zero/i);
  });
  it("computes sum, count and ratio over a window with filters", () => {
    expect(computeMetric({ kind: "sum", field: "amount", filters: [{ field: "stage", equals: "won" }] }, rows, window)).toEqual({ kind: "value", value: 4000 });
    expect(computeMetric({ kind: "count", filters: [] }, rows, window)).toEqual({ kind: "value", value: 3 });
    const win = computeMetric(
      { kind: "ratio", numerator: { kind: "count", filters: [{ field: "stage", equals: "won" }] }, denominator: { kind: "count", filters: [] } },
      rows,
      window,
    );
    expect(win.kind === "value" && win.value).toBeCloseTo(2 / 3, 12);
  });
  it("an empty window for a ratio is unknown", () => {
    const r = computeMetric(
      { kind: "ratio", numerator: { kind: "count", filters: [] }, denominator: { kind: "count", filters: [] } },
      rows,
      { start: "2025-01-01T00:00:00Z", end: "2025-02-01T00:00:00Z" },
    );
    expect(r.kind).toBe("unknown");
  });
  it("a sum across mixed currencies is unknown", () => {
    const mixed = [...rows, { ...rows[0], externalId: "d", currency: "RWF" }];
    expect(computeMetric({ kind: "sum", field: "amount", filters: [] }, mixed, window).kind).toBe("unknown");
  });
  it("freshness compares age with the threshold", () => {
    expect(freshness("2026-11-20T00:00:00Z", "2026-11-20T10:00:00Z", 24)).toEqual({ state: "fresh", ageHours: 10 });
    expect(freshness("2026-11-18T00:00:00Z", "2026-11-20T10:00:00Z", 24).state).toBe("stale");
    expect(freshness(null, "2026-11-20T10:00:00Z", 24).state).toBe("never");
  });
});

const mapping: ImportMapping = { externalId: "invoice_id", occurredAt: "date", amount: "amount", currency: "currency", defaultCurrency: "USD", extra: { segment: "segment" } };

describe("CSV import preview", () => {
  it("parses quoted fields, commas and escaped quotes", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
  });
  it("maps rows and reports duplicates, missing and invalid rows with line numbers", () => {
    const csv = [
      "invoice_id,date,amount,currency,segment",
      "INV-1,2026-10-01,1200.00,USD,smb",
      "INV-2,2026-10-02,300,,mid",
      "INV-1,2026-10-03,50,USD,smb",
      ",2026-10-04,10,USD,smb",
      "INV-4,not-a-date,10,USD,smb",
      "INV-5,2026-10-05,ten,USD,smb",
    ].join("\n");
    const p = previewImport(csv, mapping, new Set());
    expect(p.rows.map((r) => r.externalId)).toEqual(["INV-1", "INV-2"]);
    expect(p.rows[1].currency).toBe("USD");
    expect(p.rows[0].amountMinor).toBe(120_000);
    expect(p.rows[0].fields.segment).toBe("smb");
    expect(p.duplicates).toEqual([{ line: 4, reason: expect.stringContaining("INV-1") }]);
    expect(p.missing.map((m) => m.line)).toEqual([5]);
    expect(p.invalid.map((m) => m.line)).toEqual([6, 7]);
  });
  it("treats rows already imported as duplicates (replay suppression)", () => {
    const p = previewImport("invoice_id,date,amount\nINV-9,2026-10-01,1", { ...mapping, currency: undefined, extra: {} }, new Set(["INV-9"]));
    expect(p.rows).toEqual([]);
    expect(p.duplicates).toHaveLength(1);
  });
  it("reports a mapped column the file does not have", () => {
    const p = previewImport("id,when\n1,2026-01-01", mapping, new Set());
    expect(p.invalid[0].reason).toMatch(/invoice_id/);
  });
});

describe("measurement", () => {
  it("difference in means with a 95% interval and causal label for a random holdout", () => {
    const m = measureOutcome("random_holdout", [100, 120, 140, 160], [90, 100, 110, 100]);
    expect(m.liftPerUnitMinor).toBe(30);
    expect(m.incrementalTotalMinor).toBe(120);
    expect(m.attribution).toBe("causal");
    expect(m.ci95!.lowMinor).toBeLessThan(30);
    expect(m.ci95!.highMinor).toBeGreaterThan(30);
  });
  it("pre/post comparisons are labelled descriptive", () => {
    expect(measureOutcome("pre_post", [5, 6], [4, 4]).attribution).toBe("descriptive");
    expect(measureOutcome("matched_cohort", [5, 6], [4, 4]).attribution).toBe("quasi_causal");
  });
  it("records negative outcomes faithfully", () => {
    expect(measureOutcome("random_holdout", [10, 10], [20, 20]).liftPerUnitMinor).toBe(-10);
  });
  it("no interval with fewer than two observations per arm", () => {
    expect(measureOutcome("random_holdout", [10], [5]).ci95).toBeNull();
  });
  it("Brier score and skill against the base rate", () => {
    const b = brierScore([
      { p: 0.9, outcome: 1 },
      { p: 0.2, outcome: 0 },
      { p: 0.7, outcome: 1 },
      { p: 0.6, outcome: 0 },
    ]);
    expect(b.score).toBeCloseTo((0.01 + 0.04 + 0.09 + 0.36) / 4, 12);
    expect(b.baseline).toBeCloseTo(0.25, 12);
    expect(b.skill).toBeCloseTo(1 - b.score! / 0.25, 12);
    expect(brierScore([]).score).toBeNull();
  });
  it("never assigns one invoice line's amount to more than one decision in full", () => {
    const lines = [
      { id: "L1", amountMinor: 1000 },
      { id: "L2", amountMinor: 333 },
    ];
    const alloc = allocateInvoiceLines(lines, { d1: ["L1", "L2"], d2: ["L2"], d3: ["L2"] });
    const total = Object.values(alloc).reduce((a, b) => a + b, 0);
    expect(total).toBe(1333);
    expect(alloc.d1).toBe(1000 + 111);
    expect(alloc.d2 + alloc.d3).toBe(222);
  });
});

describe("moat", () => {
  it("potential = P(created & retained) × conditional value", () => {
    expect(moatPotentialMinor({ mechanism: "x", pCreatedRetained: 0.25, conditionalValueMinor: 1000, horizonMonths: 6 })).toBe(250);
  });
  it("stages advance one step at a time", () => {
    expect(advanceMoat("proposed")).toBe("created");
    expect(advanceMoat("verified")).toBe("realized");
    expect(advanceMoat("realized")).toBeNull();
  });
});
