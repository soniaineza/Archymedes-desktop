import { describe, expect, it } from "vitest";
import { evaluate, EVALUATOR_VERSION } from "./evaluator";
import { annualPlanAlternative, DEFAULT_POLICY, leadFollowUpAlternative, revenueSnapshot } from "./fixtures";
import type { DecisionSnapshot } from "./types";

const lead = (r: ReturnType<typeof evaluate>) => r.alternatives.find((a) => a.id === "alt-lead-follow-up")!;

describe("deterministic reference evaluator — spec §6 worked example", () => {
  const result = evaluate(revenueSnapshot());

  it("computes the quoted expected values exactly, in minor units", () => {
    expect(result.status).toBe("complete");
    expect(lead(result).evRevenueMinor).toBe(1_250_000);
    expect(lead(result).evContributionMinor).toBe(450_000);
  });

  it("computes per-scenario incremental contribution (60% margin, $3k cost)", () => {
    expect(lead(result).scenarios.map((s) => s.deltaContributionMinor)).toEqual([-180_000, 420_000, 1_140_000]);
    expect(lead(result).range).toEqual({ minMinor: -180_000, maxMinor: 1_140_000 });
  });

  it("models a 75% chance of ≥ $10,000 and a 25% chance of loss", () => {
    expect(lead(result).pGoal).toBeCloseTo(0.75, 12);
    expect(lead(result).pLoss).toBeCloseTo(0.25, 12);
  });

  it("recommends it under the default 30% loss limit", () => {
    expect(lead(result).eligible).toBe(true);
    expect(result.recommendationId).toBe("alt-lead-follow-up");
    expect(lead(result).rank).toBe(1);
  });

  it("gates it when the company's maximum loss probability is 20%", () => {
    const gated = evaluate(revenueSnapshot({ policy: { ...DEFAULT_POLICY, maxLossProbability: 0.2 } }));
    expect(gated.status).toBe("complete");
    expect(lead(gated).eligible).toBe(false);
    expect(lead(gated).gates.find((g) => g.key === "max_loss_probability")?.passed).toBe(false);
    expect(gated.recommendationId).toBeNull();
    expect(gated.questions.join(" ")).toMatch(/smaller pilot|better evidence/i);
  });

  it("stamps the evaluator version and never ranks the baseline", () => {
    expect(result.evaluatorVersion).toBe(EVALUATOR_VERSION);
    const base = result.alternatives.find((a) => a.isBaseline)!;
    expect(base.rank).toBeNull();
    expect(base.evContributionMinor).toBe(0);
  });
});

describe("evaluator invariants", () => {
  it("is deterministic: the same snapshot replays to the same result", () => {
    const s = revenueSnapshot({ alternatives: [...revenueSnapshot().alternatives, annualPlanAlternative("2026-11-18T09:00:00.000Z")] });
    expect(evaluate(s)).toEqual(evaluate(structuredClone(s)));
  });

  it("ranks eligible options by expected contribution", () => {
    const asOf = "2026-11-18T09:00:00.000Z";
    const r = evaluate(revenueSnapshot({ alternatives: [...revenueSnapshot().alternatives, annualPlanAlternative(asOf)] }));
    const ranked = r.alternatives.filter((a) => a.rank !== null).sort((a, b) => a.rank! - b.rank!);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].evContributionMinor!).toBeGreaterThanOrEqual(ranked[i].evContributionMinor!);
  });

  it("probabilities that do not sum to one need evidence, with partial outputs kept", () => {
    const s = revenueSnapshot();
    s.alternatives[1].scenarios[2].probability = 0.3;
    const r = evaluate(s);
    expect(r.status).toBe("needs_evidence");
    expect(r.missing.some((m) => m.field === "probability")).toBe(true);
    expect(lead(r).complete).toBe(false);
    expect(lead(r).evContributionMinor).toBeNull();
  });

  it("a missing revenue figure needs evidence instead of guessing", () => {
    const s = revenueSnapshot();
    s.alternatives[1].scenarios[0].revenueMinor = null;
    const r = evaluate(s);
    expect(r.status).toBe("needs_evidence");
    expect(r.missing).toContainEqual(expect.objectContaining({ alternativeId: "alt-lead-follow-up", field: "revenue" }));
  });

  it("no margin and no explicit contribution needs evidence", () => {
    const r = evaluate(revenueSnapshot({ grossMarginBps: null }));
    expect(r.status).toBe("needs_evidence");
    expect(r.missing.some((m) => m.field === "contribution")).toBe(true);
  });

  it("an explicit contribution overrides the margin derivation", () => {
    const s = revenueSnapshot({ grossMarginBps: null });
    for (const alt of s.alternatives)
      for (const sc of alt.scenarios) sc.contributionBeforeCostMinor = Math.round(sc.revenueMinor! * 0.6);
    expect(lead(evaluate(s)).evContributionMinor).toBe(450_000);
  });

  it("fails without a no-change baseline", () => {
    const s = revenueSnapshot();
    s.alternatives = s.alternatives.filter((a) => !a.isBaseline);
    const r = evaluate(s);
    expect(r.status).toBe("failed");
    expect(r.failure).toMatch(/baseline/i);
  });

  it("fails on a scenario the baseline does not define", () => {
    const s = revenueSnapshot();
    s.alternatives[1].scenarios[0].key = "recession";
    expect(evaluate(s).status).toBe("failed");
  });

  it("rejects non-integer money and probabilities outside [0,1]", () => {
    const a = revenueSnapshot();
    a.alternatives[1].scenarios[0].revenueMinor = 12.5;
    expect(evaluate(a).status).toBe("failed");
    const b = revenueSnapshot();
    b.alternatives[1].scenarios[0].probability = -0.1;
    expect(evaluate(b).status).toBe("failed");
  });

  it("stale inputs fail the freshness gate", () => {
    const s = revenueSnapshot({}, "2026-11-18T09:00:00.000Z");
    s.asOf = "2027-03-01T00:00:00.000Z";
    const r = evaluate(s);
    expect(lead(r).gates.find((g) => g.key === "data_freshness")?.passed).toBe(false);
    expect(lead(r).eligible).toBe(false);
  });

  it("spend above the cap is ineligible", () => {
    const r = evaluate(revenueSnapshot({ policy: { ...DEFAULT_POLICY, maxSpendMinor: 100_00 } }));
    expect(lead(r).gates.find((g) => g.key === "max_spend")?.passed).toBe(false);
  });

  it("downside exposure beyond the limit is ineligible", () => {
    const r = evaluate(revenueSnapshot({ policy: { ...DEFAULT_POLICY, maxDownsideExposureMinor: 100_000 } }));
    expect(lead(r).gates.find((g) => g.key === "max_downside_exposure")?.passed).toBe(false);
  });

  it("candidate-specific probabilities are used independently per alternative", () => {
    const asOf = "2026-11-18T09:00:00.000Z";
    const r = evaluate(revenueSnapshot({ alternatives: [...revenueSnapshot().alternatives, annualPlanAlternative(asOf)] }));
    const annual = r.alternatives.find((a) => a.id === "alt-annual-plan")!;
    // 0.3·(0.6·100000−150000) + 0.5·(0.6·700000−150000) + 0.2·(0.6·1300000−150000)
    expect(annual.evContributionMinor).toBe(234_000);
  });

  it("reports sensitivities for the recommended option, largest swing first", () => {
    const r = evaluate(revenueSnapshot());
    expect(r.sensitivities.length).toBeGreaterThan(0);
    const swings = r.sensitivities.map((s) => Math.abs(s.highMinor - s.lowMinor));
    expect([...swings].sort((a, b) => b - a)).toEqual(swings);
    for (const s of r.sensitivities) expect(s.lowMinor).toBeLessThanOrEqual(s.highMinor);
  });

  it("flags a close call when two options are near and a plausible swing flips the order", () => {
    const asOf = "2026-11-18T09:00:00.000Z";
    const twin = leadFollowUpAlternative(asOf);
    twin.id = "alt-twin";
    twin.name = "Twin";
    twin.overlapKey = "other";
    twin.scenarios = twin.scenarios.map((s) => ({ ...s, revenueMinor: s.revenueMinor! + 5_000 }));
    const r = evaluate(revenueSnapshot({ alternatives: [...revenueSnapshot().alternatives, twin] }));
    expect(r.closeCall).toBe(true);
  });

  it("keeps moat value separate from contribution", () => {
    const r = evaluate(revenueSnapshot());
    expect(lead(r).moatPotentialMinor).toBe(Math.round(0.4 * 1_800_000));
    expect(lead(r).evContributionMinor).toBe(450_000);
  });

  it("a currency mismatch between snapshot and policy context fails clearly", () => {
    const s: DecisionSnapshot = { ...revenueSnapshot(), currency: "usd" };
    expect(evaluate(s).status).toBe("failed");
  });
});
