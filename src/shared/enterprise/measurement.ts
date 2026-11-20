import type { ComparisonMethod, OutcomeMeasurement } from "./types";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]) => {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};

/** Two-sided 97.5% t quantile; normal beyond 30 degrees of freedom. */
function t975(df: number): number {
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  return df >= 1 && df <= 30 ? table[Math.floor(df) - 1] : 1.96;
}

const LABELS: Record<ComparisonMethod, { attribution: OutcomeMeasurement["attribution"]; label: string }> = {
  random_holdout: { attribution: "causal", label: "Randomized holdout — causal estimate" },
  matched_cohort: { attribution: "quasi_causal", label: "Matched cohort — quasi-causal, confounders recorded" },
  pre_post: { attribution: "descriptive", label: "Pre/post — descriptive change, not attribution" },
};

/**
 * Difference in mean outcome per account (treated − comparison) with a Welch
 * 95% interval. Values are per-account outcomes in minor units.
 */
export function measureOutcome(method: ComparisonMethod, treated: number[], comparison: number[]): OutcomeMeasurement {
  const lift = mean(treated) - mean(comparison);
  let ci95: OutcomeMeasurement["ci95"] = null;
  if (treated.length >= 2 && comparison.length >= 2) {
    const a = variance(treated) / treated.length;
    const b = variance(comparison) / comparison.length;
    const se = Math.sqrt(a + b);
    const df = se === 0 ? 30 : (a + b) ** 2 / (a ** 2 / (treated.length - 1) + b ** 2 / (comparison.length - 1));
    const half = t975(df) * se;
    ci95 = { lowMinor: Math.round(lift - half), highMinor: Math.round(lift + half) };
  }
  return {
    method,
    treatedN: treated.length,
    comparisonN: comparison.length,
    liftPerUnitMinor: Math.round(lift),
    ci95,
    incrementalTotalMinor: Math.round(lift * treated.length),
    attribution: LABELS[method].attribution,
    confidenceLabel: LABELS[method].label,
  };
}

/** Brier score, the base-rate (climatology) baseline, and skill = 1 − score/baseline. */
export function brierScore(points: { p: number; outcome: 0 | 1 }[]): { score: number | null; baseline: number | null; skill: number | null; n: number } {
  if (!points.length) return { score: null, baseline: null, skill: null, n: 0 };
  const score = mean(points.map((x) => (x.p - x.outcome) ** 2));
  const rate = mean(points.map((x) => x.outcome));
  const baseline = mean(points.map((x) => (rate - x.outcome) ** 2));
  return { score, baseline, skill: baseline === 0 ? null : 1 - score / baseline, n: points.length };
}

/**
 * Splits invoice-line revenue among the decisions that claim it. A line claimed
 * by k decisions is divided equally (remainder cents to the earliest decision
 * IDs), so no amount is ever counted twice.
 */
export function allocateInvoiceLines(lines: { id: string; amountMinor: number }[], claims: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(Object.keys(claims).map((d) => [d, 0]));
  for (const line of lines) {
    const claimants = Object.keys(claims)
      .filter((d) => claims[d].includes(line.id))
      .sort();
    if (!claimants.length) continue;
    const share = Math.trunc(line.amountMinor / claimants.length);
    let rest = line.amountMinor - share * claimants.length;
    for (const d of claimants) {
      out[d] += share + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
    }
  }
  return out;
}
