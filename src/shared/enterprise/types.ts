/**
 * Archymedes Desktop — enterprise domain types (spec v0.1, 20 Nov 2026).
 *
 * Everything here is plain data so it can cross IPC and, later, HTTP unchanged.
 * Instants are UTC ISO-8601 strings. Money is always a currency code plus an
 * integer amount of minor units; floats never carry money.
 */

export type Iso = string;

export interface Money {
  currency: string;
  minor: number;
}

/** Where a material input came from. */
export type Origin = "observed" | "estimated" | "unknown";

export interface Provenance {
  source: string;
  asOf: Iso;
  origin: Origin;
}

// ---------------------------------------------------------------------------
// Orion evaluation
// ---------------------------------------------------------------------------

export interface ScenarioInput {
  key: string;
  label: string;
  /** p[a,s]; null = not yet known. */
  probability: number | null;
  /** Total revenue for this alternative in this scenario over the horizon, minor units. */
  revenueMinor: number | null;
  /** Contribution before the action's own cost (includes incremental variable delivery costs). Null derives it from gross margin. */
  contributionBeforeCostMinor?: number | null;
  /** Cost of taking this action in this scenario, minor units (0 for the baseline). */
  actionCostMinor: number | null;
  /** The objective metric at the deadline, when the goal is set on the metric itself. */
  metricAtDeadline?: number | null;
}

export interface Assumption {
  key: string;
  label: string;
  value: string;
  provenance: Provenance;
}

export interface AlternativeInput {
  id: string;
  name: string;
  isBaseline: boolean;
  hypothesis?: string;
  scenarios: ScenarioInput[];
  /** Up-front spend the policy's spend cap applies to, minor units. */
  spendMinor: number;
  timeToEffectDays: number;
  /** Interventions targeting the same segment or conversion step share a key. */
  overlapKey?: string;
  assumptions: Assumption[];
  moat?: MoatEstimate;
}

export interface MoatEstimate {
  mechanism: string;
  /** Probability the asset is created and retained over its horizon. */
  pCreatedRetained: number;
  /** Incremental value conditional on the asset existing, minor units. */
  conditionalValueMinor: number;
  horizonMonths: number;
}

export type GoalBasis = "incremental_revenue" | "metric_at_deadline";

export interface GoalSpec {
  basis: GoalBasis;
  direction: "increase" | "decrease";
  /** Minor units for incremental_revenue; metric units otherwise. */
  target: number;
  label: string;
}

export interface EvaluationPolicy {
  /** Maximum modeled probability of negative incremental contribution. */
  maxLossProbability: number;
  /** Maximum up-front spend per action, minor units. */
  maxSpendMinor: number;
  /** Worst-scenario incremental contribution may not fall below minus this, minor units. */
  maxDownsideExposureMinor: number;
  /** Inputs older than this are stale. */
  maxInputAgeDays: number;
}

export interface DecisionSnapshot {
  decisionId: string;
  decisionRevision: number;
  objectiveLabel: string;
  currency: string;
  horizonDays: number;
  asOf: Iso;
  /** Used when a scenario gives no explicit contribution: contribution = revenue × margin. */
  grossMarginBps: number | null;
  /** Number of accounts in the treated cohort; context only. */
  cohortSize: number;
  goal: GoalSpec;
  policy: EvaluationPolicy;
  alternatives: AlternativeInput[];
}

export type GateKey = "max_spend" | "max_loss_probability" | "max_downside_exposure" | "data_freshness";

export interface GateResult {
  key: GateKey;
  passed: boolean;
  detail: string;
}

export interface ScenarioResult {
  key: string;
  label: string;
  probability: number;
  deltaRevenueMinor: number;
  deltaContributionMinor: number;
  meetsGoal: boolean;
}

export interface AlternativeResult {
  id: string;
  name: string;
  isBaseline: boolean;
  complete: boolean;
  eligible: boolean;
  gates: GateResult[];
  evRevenueMinor: number | null;
  evContributionMinor: number | null;
  pGoal: number | null;
  pLoss: number | null;
  range: { minMinor: number; maxMinor: number } | null;
  scenarios: ScenarioResult[];
  moatPotentialMinor: number | null;
  /** 1 = recommended. Null for the baseline and ineligible options. */
  rank: number | null;
}

export interface Sensitivity {
  key: string;
  label: string;
  /** EV contribution of the recommended option at the low and high end of the plausible range. */
  lowMinor: number;
  highMinor: number;
  /** True when the swing changes which option ranks first. */
  flipsRanking: boolean;
}

export interface MissingInput {
  alternativeId: string | null;
  field: string;
  detail: string;
}

export type EvaluationStatus = "complete" | "needs_evidence" | "failed";

export interface EvaluationResult {
  status: EvaluationStatus;
  evaluatorVersion: string;
  currency: string;
  horizonDays: number;
  goalLabel: string;
  alternatives: AlternativeResult[];
  recommendationId: string | null;
  closeCall: boolean;
  sensitivities: Sensitivity[];
  missing: MissingInput[];
  questions: string[];
  /** Plain-language reason when status is failed. */
  failure?: string;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const DECISION_STATES = [
  "Draft",
  "Evaluated",
  "NeedsEvidence",
  "AwaitingApproval",
  "Approved",
  "Rejected",
  "Executing",
  "DeliveryReview",
  "Measuring",
  "Debriefed",
  "Cancelled",
] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

// ---------------------------------------------------------------------------
// Metrics & import
// ---------------------------------------------------------------------------

export type MetricValue = { kind: "value"; value: number } | { kind: "unknown"; reason: string };

export interface MetricFilter {
  field: string;
  equals: string;
}

export type MetricCalc =
  | { kind: "sum"; field: string; filters: MetricFilter[] }
  | { kind: "count"; filters: MetricFilter[] }
  | {
      kind: "ratio";
      numerator: { kind: "sum" | "count"; field?: string; filters: MetricFilter[] };
      denominator: { kind: "sum" | "count"; field?: string; filters: MetricFilter[] };
    };

export type MetricUnit = "money" | "count" | "ratio";

/** One imported business record after mapping. */
export interface SourceRow {
  externalId: string;
  occurredAt: Iso;
  currency: string;
  amountMinor: number;
  fields: Record<string, string>;
}

export interface ImportMapping {
  externalId: string;
  occurredAt: string;
  amount: string;
  currency?: string;
  defaultCurrency: string;
  /** Extra columns kept as string fields, keyed by our field name → CSV column. */
  extra: Record<string, string>;
}

export interface ImportIssue {
  line: number;
  reason: string;
}

export interface ImportPreview {
  header: string[];
  rows: SourceRow[];
  duplicates: ImportIssue[];
  missing: ImportIssue[];
  invalid: ImportIssue[];
}

// ---------------------------------------------------------------------------
// Measurement & learning
// ---------------------------------------------------------------------------

export type ComparisonMethod = "random_holdout" | "matched_cohort" | "pre_post";

export interface OutcomeMeasurement {
  method: ComparisonMethod;
  treatedN: number;
  comparisonN: number;
  /** Difference in mean outcome per account, minor units. */
  liftPerUnitMinor: number;
  ci95: { lowMinor: number; highMinor: number } | null;
  /** Lift per unit × treated accounts. */
  incrementalTotalMinor: number;
  attribution: "causal" | "quasi_causal" | "descriptive";
  confidenceLabel: string;
}

export type MoatStage = "proposed" | "created" | "verified" | "realized";
