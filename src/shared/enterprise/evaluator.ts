import { isCurrencyCode } from "./money";
import { moatPotentialMinor } from "./moat";
import type {
  AlternativeInput,
  AlternativeResult,
  DecisionSnapshot,
  EvaluationResult,
  GateResult,
  MissingInput,
  ScenarioInput,
  ScenarioResult,
  Sensitivity,
} from "./types";

/**
 * Orion deterministic reference evaluator (spec §6).
 *
 *   Δrevenue[a,s]      = revenue[a,s] − baseline_revenue[s]
 *   Δcontribution[a,s] = contribution_before_cost[a,s] − baseline_contribution[s] − action_cost[a,s]
 *   EV(a)     = Σ_s p[a,s] · Δcontribution[a,s]
 *   P_goal(a) = Σ_s p[a,s] · 1(goal met at deadline)
 *   P_loss(a) = Σ_s p[a,s] · 1(Δcontribution[a,s] < 0)
 *
 * Probabilities are candidate-specific; each alternative's expectation is
 * computed independently against the shared no-change baseline. Hard
 * constraints apply before ranking; eligible options rank by EV contribution.
 * Pure and deterministic: the same snapshot always yields the same result.
 */
export const EVALUATOR_VERSION = "orion-ref-1.0.0";

const P_TOLERANCE = 1e-9;
const DAY_MS = 86_400_000;

interface Mods {
  /** Probability mass moved from the first scenario to the last (negative moves it back). */
  shiftMass?: number;
  marginDeltaBps?: number;
  costScale?: number;
  liftScale?: number;
}

class Structural extends Error {}

function isIntOrNull(v: number | null | undefined): boolean {
  return v === null || v === undefined || Number.isSafeInteger(v);
}

function validate(s: DecisionSnapshot): void {
  if (!isCurrencyCode(s.currency)) throw new Structural(`currency "${s.currency}" is not an ISO code like USD`);
  const baselines = s.alternatives.filter((a) => a.isBaseline);
  if (baselines.length !== 1) throw new Structural("exactly one no-change baseline is required");
  if (s.alternatives.length < 2) throw new Structural("at least one candidate besides the baseline is required");
  const keys = new Set(baselines[0].scenarios.map((x) => x.key));
  for (const a of s.alternatives) {
    if (!Number.isSafeInteger(a.spendMinor)) throw new Structural(`${a.name}: spend must be integer minor units`);
    for (const sc of a.scenarios) {
      if (!keys.has(sc.key)) throw new Structural(`${a.name}: scenario "${sc.key}" is not defined for the baseline`);
      if (!isIntOrNull(sc.revenueMinor) || !isIntOrNull(sc.actionCostMinor) || !isIntOrNull(sc.contributionBeforeCostMinor))
        throw new Structural(`${a.name}/${sc.label}: money must be integer minor units`);
      if (sc.probability !== null && !(sc.probability >= 0 && sc.probability <= 1))
        throw new Structural(`${a.name}/${sc.label}: probability must be between 0 and 1`);
    }
  }
}

function contribution(sc: ScenarioInput, marginBps: number | null): number | null {
  if (sc.contributionBeforeCostMinor !== undefined && sc.contributionBeforeCostMinor !== null) return sc.contributionBeforeCostMinor;
  if (marginBps === null || sc.revenueMinor === null) return null;
  return Math.round((sc.revenueMinor * marginBps) / 10_000);
}

function missingFor(a: AlternativeInput, margin: number | null): MissingInput[] {
  const out: MissingInput[] = [];
  const add = (field: string, detail: string) => out.push({ alternativeId: a.id, field, detail });
  for (const sc of a.scenarios) {
    if (sc.probability === null) add("probability", `${a.name}: ${sc.label} probability is unknown`);
    if (sc.revenueMinor === null) add("revenue", `${a.name}: ${sc.label} revenue is unknown`);
    if (sc.actionCostMinor === null) add("cost", `${a.name}: ${sc.label} action cost is unknown`);
    if (sc.revenueMinor !== null && contribution(sc, margin) === null) add("contribution", `${a.name}: ${sc.label} needs a contribution or a gross margin`);
  }
  const ps = a.scenarios.map((x) => x.probability);
  if (ps.every((p) => p !== null)) {
    const sum = (ps as number[]).reduce((x, y) => x + y, 0);
    if (Math.abs(sum - 1) > P_TOLERANCE) add("probability", `${a.name}: scenario probabilities sum to ${sum.toFixed(3)}, not 1`);
  }
  return out;
}

function scenarioResults(s: DecisionSnapshot, a: AlternativeInput, base: AlternativeInput, mods: Mods = {}): ScenarioResult[] {
  const margin = s.grossMarginBps === null ? null : s.grossMarginBps + (mods.marginDeltaBps ?? 0);
  const probs = a.scenarios.map((x) => x.probability as number);
  if (mods.shiftMass && probs.length >= 2) {
    const last = probs.length - 1;
    const m = mods.shiftMass > 0 ? Math.min(mods.shiftMass, probs[0]) : -Math.min(-mods.shiftMass, probs[last]);
    probs[0] -= m;
    probs[last] += m;
  }
  return a.scenarios.map((sc, i) => {
    const b = base.scenarios.find((x) => x.key === sc.key)!;
    const liftScale = mods.liftScale ?? 1;
    const deltaRevenue = Math.round((sc.revenueMinor! - b.revenueMinor!) * liftScale);
    const revenue = b.revenueMinor! + deltaRevenue;
    const contrib = contribution({ ...sc, revenueMinor: revenue, contributionBeforeCostMinor: liftScale === 1 ? sc.contributionBeforeCostMinor : null }, margin) ?? 0;
    const baseContrib = contribution(b, margin) ?? 0;
    const cost = Math.round(sc.actionCostMinor! * (mods.costScale ?? 1));
    const deltaContribution = contrib - baseContrib - cost;
    const goal = s.goal;
    const value = goal.basis === "incremental_revenue" ? deltaRevenue : (sc.metricAtDeadline ?? Number.NaN);
    const meetsGoal = goal.direction === "increase" ? value >= goal.target : value <= goal.target;
    return { key: sc.key, label: sc.label, probability: probs[i], deltaRevenueMinor: deltaRevenue, deltaContributionMinor: deltaContribution, meetsGoal };
  });
}

const expect = (rows: ScenarioResult[], f: (r: ScenarioResult) => number) => rows.reduce((sum, r) => sum + r.probability * f(r), 0);

function gatesFor(s: DecisionSnapshot, a: AlternativeInput, pLoss: number | null, minDelta: number | null): GateResult[] {
  const p = s.policy;
  const gates: GateResult[] = [
    { key: "max_spend", passed: a.spendMinor <= p.maxSpendMinor, detail: `spend ${a.spendMinor} vs cap ${p.maxSpendMinor}` },
  ];
  if (pLoss !== null)
    gates.push({ key: "max_loss_probability", passed: pLoss <= p.maxLossProbability + P_TOLERANCE, detail: `P(loss) ${(pLoss * 100).toFixed(1)}% vs limit ${(p.maxLossProbability * 100).toFixed(0)}%` });
  if (minDelta !== null)
    gates.push({ key: "max_downside_exposure", passed: minDelta >= -p.maxDownsideExposureMinor, detail: `worst case ${minDelta} vs limit −${p.maxDownsideExposureMinor}` });
  const asOf = Date.parse(s.asOf);
  const stale = a.assumptions.filter((x) => x.provenance.origin === "unknown" || (asOf - Date.parse(x.provenance.asOf)) / DAY_MS > p.maxInputAgeDays);
  gates.push({
    key: "data_freshness",
    passed: stale.length === 0,
    detail: stale.length ? `stale or unknown: ${stale.map((x) => x.label).join(", ")}` : `all inputs within ${p.maxInputAgeDays} days`,
  });
  return gates;
}

function failed(s: DecisionSnapshot, reason: string): EvaluationResult {
  return {
    status: "failed",
    evaluatorVersion: EVALUATOR_VERSION,
    currency: s.currency,
    horizonDays: s.horizonDays,
    goalLabel: s.goal?.label ?? "",
    alternatives: [],
    recommendationId: null,
    closeCall: false,
    sensitivities: [],
    missing: [],
    questions: [],
    failure: reason,
  };
}

export function evaluate(s: DecisionSnapshot): EvaluationResult {
  try {
    validate(s);
  } catch (e) {
    if (e instanceof Structural) return failed(s, e.message);
    throw e;
  }
  const base = s.alternatives.find((a) => a.isBaseline)!;
  const baseMissing = missingFor(base, s.grossMarginBps);
  const missing: MissingInput[] = [...baseMissing];

  const results: AlternativeResult[] = s.alternatives.map((a) => {
    const own = a.isBaseline ? [] : missingFor(a, s.grossMarginBps);
    missing.push(...own);
    const complete = own.length === 0 && baseMissing.length === 0;
    if (!complete)
      return { id: a.id, name: a.name, isBaseline: a.isBaseline, complete, eligible: false, gates: [], evRevenueMinor: null, evContributionMinor: null, pGoal: null, pLoss: null, range: null, scenarios: [], moatPotentialMinor: a.moat ? moatPotentialMinor(a.moat) : null, rank: null };
    const rows = scenarioResults(s, a, base);
    const ev = Math.round(expect(rows, (r) => r.deltaContributionMinor));
    const pLoss = expect(rows, (r) => (r.deltaContributionMinor < 0 ? 1 : 0));
    const deltas = rows.map((r) => r.deltaContributionMinor);
    const range = { minMinor: Math.min(...deltas), maxMinor: Math.max(...deltas) };
    const gates = a.isBaseline ? [] : gatesFor(s, a, pLoss, range.minMinor);
    return {
      id: a.id,
      name: a.name,
      isBaseline: a.isBaseline,
      complete,
      eligible: gates.every((g) => g.passed),
      gates,
      evRevenueMinor: Math.round(expect(rows, (r) => r.deltaRevenueMinor)),
      evContributionMinor: ev,
      pGoal: expect(rows, (r) => (r.meetsGoal ? 1 : 0)),
      pLoss,
      range,
      scenarios: rows,
      moatPotentialMinor: a.moat ? moatPotentialMinor(a.moat) : null,
      rank: null,
    };
  });

  const ranked = results
    .filter((r) => !r.isBaseline && r.complete && r.eligible)
    .sort((x, y) => y.evContributionMinor! - x.evContributionMinor! || y.pGoal! - x.pGoal! || x.id.localeCompare(y.id));
  ranked.forEach((r, i) => (r.rank = i + 1));

  const top = ranked[0] ?? null;
  const recommendationId = top ? (top.evContributionMinor! > 0 ? top.id : base.id) : null;
  const runnerUpEv = ranked[1]?.evContributionMinor ?? 0;

  const sensitivities: Sensitivity[] = [];
  if (top) {
    const alt = s.alternatives.find((a) => a.id === top.id)!;
    const evWith = (m: Mods) => Math.round(expect(scenarioResults(s, alt, base, m), (r) => r.deltaContributionMinor));
    const probe = (key: string, label: string, lo: Mods, hi: Mods) => {
      const a = evWith(lo);
      const b = evWith(hi);
      const lowMinor = Math.min(a, b);
      const highMinor = Math.max(a, b);
      sensitivities.push({ key, label, lowMinor, highMinor, flipsRanking: lowMinor < runnerUpEv });
    };
    probe("probabilities", "Scenario probabilities ±10 pts (downside ↔ upside)", { shiftMass: -0.1 }, { shiftMass: 0.1 });
    probe("lift", "Revenue lift ±20%", { liftScale: 0.8 }, { liftScale: 1.2 });
    probe("cost", "Action cost ±25%", { costScale: 1.25 }, { costScale: 0.75 });
    if (s.grossMarginBps !== null) probe("margin", "Gross margin ±10 pts", { marginDeltaBps: -1000 }, { marginDeltaBps: 1000 });
    sensitivities.sort((x, y) => y.highMinor - y.lowMinor - (x.highMinor - x.lowMinor) || x.key.localeCompare(y.key));
  }

  const spread = top?.range ? top.range.maxMinor - top.range.minMinor : 0;
  const near = ranked.length > 1 && Math.abs(top!.evContributionMinor! - runnerUpEv) <= 0.1 * spread;
  const closeCall = near || sensitivities.some((x) => x.flipsRanking);

  const questions: string[] = [];
  for (const r of results) {
    const lossGate = r.gates.find((g) => g.key === "max_loss_probability" && !g.passed);
    if (lossGate) questions.push(`${r.name} exceeds the loss limit (${lossGate.detail}). Gather better evidence on the downside, or add a smaller pilot as a fresh alternative.`);
    const stale = r.gates.find((g) => g.key === "data_freshness" && !g.passed);
    if (stale) questions.push(`${r.name}: refresh ${stale.detail.replace(/^stale or unknown: /, "")} before deciding.`);
  }
  if (closeCall && sensitivities[0])
    questions.push(`The ranking is close. ${sensitivities[0].label.replace(/ ±.*$/, "")} moves the answer most — evidence there has the highest decision value.`);
  for (const m of missing) questions.push(`Provide: ${m.detail}.`);

  return {
    status: missing.length ? "needs_evidence" : "complete",
    evaluatorVersion: EVALUATOR_VERSION,
    currency: s.currency,
    horizonDays: s.horizonDays,
    goalLabel: s.goal.label,
    alternatives: results,
    recommendationId,
    closeCall,
    sensitivities,
    missing,
    questions,
  };
}
