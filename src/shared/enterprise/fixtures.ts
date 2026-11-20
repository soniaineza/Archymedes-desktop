import type { AlternativeInput, DecisionSnapshot, EvaluationPolicy } from "./types";

/**
 * The worked revenue example from spec §6, used as the calculator fixture and
 * as the seeded demo decision. Baseline revenue is the same in every scenario,
 * so revenue deltas are the incremental figures quoted in the spec.
 */
const BASE_REVENUE = 40_000_000; // $400,000 over 90 days, no-change baseline
const usd = (dollars: number): number => Math.round(dollars * 100);

export const DEFAULT_POLICY: EvaluationPolicy = {
  maxLossProbability: 0.3,
  maxSpendMinor: usd(25_000),
  maxDownsideExposureMinor: usd(10_000),
  maxInputAgeDays: 45,
};

export function baselineAlternative(asOf: string): AlternativeInput {
  return {
    id: "alt-baseline",
    name: "No change",
    isBaseline: true,
    hypothesis: "Keep the current follow-up process.",
    spendMinor: 0,
    timeToEffectDays: 0,
    assumptions: [
      { key: "base-revenue", label: "Run-rate revenue, 90 days", value: "$400,000", provenance: { source: "billing.csv", asOf, origin: "observed" } },
    ],
    scenarios: [
      { key: "downside", label: "Downside", probability: 0.25, revenueMinor: BASE_REVENUE, actionCostMinor: 0 },
      { key: "base", label: "Base", probability: 0.5, revenueMinor: BASE_REVENUE, actionCostMinor: 0 },
      { key: "upside", label: "Upside", probability: 0.25, revenueMinor: BASE_REVENUE, actionCostMinor: 0 },
    ],
  };
}

/** §6: incremental revenue $2k / $12k / $24k at p 0.25 / 0.50 / 0.25, 60% margin, $3k cost. */
export function leadFollowUpAlternative(asOf: string): AlternativeInput {
  return {
    id: "alt-lead-follow-up",
    name: "48-hour lead follow-up",
    isBaseline: false,
    hypothesis: "Calling inbound trials within 48 hours lifts trial-to-paid conversion.",
    spendMinor: usd(3_000),
    timeToEffectDays: 21,
    overlapKey: "trial-conversion",
    assumptions: [
      { key: "margin", label: "Gross margin", value: "60%", provenance: { source: "finance plan FY26", asOf, origin: "estimated" } },
      { key: "probabilities", label: "Scenario probabilities", value: "25 / 50 / 25", provenance: { source: "revenue lead estimate", asOf, origin: "estimated" } },
      { key: "cost", label: "Action cost", value: "$3,000", provenance: { source: "SDR time at loaded cost", asOf, origin: "estimated" } },
    ],
    moat: { mechanism: "Reusable lead-routing playbook + labelled response-time dataset", pCreatedRetained: 0.4, conditionalValueMinor: usd(18_000), horizonMonths: 18 },
    scenarios: [
      { key: "downside", label: "Downside", probability: 0.25, revenueMinor: BASE_REVENUE + usd(2_000), actionCostMinor: usd(3_000) },
      { key: "base", label: "Base", probability: 0.5, revenueMinor: BASE_REVENUE + usd(12_000), actionCostMinor: usd(3_000) },
      { key: "upside", label: "Upside", probability: 0.25, revenueMinor: BASE_REVENUE + usd(24_000), actionCostMinor: usd(3_000) },
    ],
  };
}

/** A second candidate so the comparison has a real alternative. */
export function annualPlanAlternative(asOf: string): AlternativeInput {
  return {
    id: "alt-annual-plan",
    name: "Annual-plan discount at renewal",
    isBaseline: false,
    hypothesis: "Offering 10% off annual prepay converts monthly renewals and cuts churn.",
    spendMinor: usd(1_500),
    timeToEffectDays: 30,
    overlapKey: "renewal",
    assumptions: [
      { key: "uptake", label: "Annual uptake", value: "8–20% of renewals", provenance: { source: "2025 pricing test", asOf, origin: "observed" } },
      { key: "discount", label: "Discount cost", value: "10% of converted ARR", provenance: { source: "pricing policy", asOf, origin: "observed" } },
    ],
    moat: { mechanism: "Higher annual-prepay share (switching cost)", pCreatedRetained: 0.55, conditionalValueMinor: usd(9_000), horizonMonths: 12 },
    scenarios: [
      { key: "downside", label: "Downside", probability: 0.3, revenueMinor: BASE_REVENUE + usd(1_000), actionCostMinor: usd(1_500) },
      { key: "base", label: "Base", probability: 0.5, revenueMinor: BASE_REVENUE + usd(7_000), actionCostMinor: usd(1_500) },
      { key: "upside", label: "Upside", probability: 0.2, revenueMinor: BASE_REVENUE + usd(13_000), actionCostMinor: usd(1_500) },
    ],
  };
}

export function revenueSnapshot(overrides: Partial<DecisionSnapshot> = {}, asOf = "2026-11-18T09:00:00.000Z"): DecisionSnapshot {
  return {
    decisionId: "dec-fixture",
    decisionRevision: 1,
    objectiveLabel: "Net new revenue, Q1",
    currency: "USD",
    horizonDays: 90,
    asOf,
    grossMarginBps: 6000,
    cohortSize: 420,
    goal: { basis: "incremental_revenue", direction: "increase", target: usd(10_000), label: "≥ $10,000 incremental revenue in 90 days" },
    policy: DEFAULT_POLICY,
    alternatives: [baselineAlternative(asOf), leadFollowUpAlternative(asOf)],
    ...overrides,
  };
}
