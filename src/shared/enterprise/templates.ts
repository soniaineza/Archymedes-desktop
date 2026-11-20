import type {
  Approval,
  AuditEvent,
  BusinessModel,
  BusinessProfile,
  Decision,
  Evaluation,
  Evidence,
  ForecastRecord,
  ImportRecord,
  Member,
  MetricDefinition,
  MoatAsset,
  Objective,
  Outcome,
  OutboxAction,
  PolicyVersion,
  Role,
  StoredRow,
  Tenant,
  WorkLink,
} from "./api-types";
import { evaluate } from "./evaluator";
import { measureOutcome } from "./measurement";
import { isCurrencyCode, minorDigits } from "./money";
import { hashSnapshot } from "./snapshot-hash";
import type { AlternativeInput, DecisionState, MetricCalc, MoatEstimate } from "./types";

/**
 * Business-model templates (spec §4). A template only supplies starting
 * defaults — objective, metrics, leading signals, guardrails and example
 * interventions; the company edits all of it. Nothing here names a real
 * company, place or person.
 */

export interface ExampleIntervention {
  name: string;
  hypothesis: string;
  overlapKey: string;
  spendMajor: number;
  costMajor: number;
  p: [number, number, number];
  /** Incremental revenue per scenario (downside / base / upside), major units. */
  incMajor: [number, number, number];
  moat?: { mechanism: string; pCreatedRetained: number; conditionalValueMajor: number; horizonMonths: number };
}

export interface TemplateMetric {
  key: string;
  name: string;
  description: string;
  unit: MetricDefinition["unit"];
  calc: MetricCalc;
  primary?: boolean;
}

export interface BusinessTemplate {
  model: BusinessModel;
  label: string;
  description: string;
  objectiveName: string;
  /** Sample-data target: baseline × (1 + growth). */
  growth: number;
  metrics: TemplateMetric[];
  leadingIndicators: string[];
  guardrails: string[];
  grossMarginBps: number;
  departments: string[];
  interventionTargetMajor: number;
  examples: ExampleIntervention[];
  pastInitiatives: string[];
}

const revenueMetric = (name: string, description: string): TemplateMetric => ({ key: "revenue", name, description, unit: "money", calc: { kind: "sum", field: "amount", filters: [] }, primary: true });

export const BUSINESS_TEMPLATES: BusinessTemplate[] = [
  {
    model: "subscription",
    label: "Subscription software",
    description: "Recurring revenue from plans and renewals.",
    objectiveName: "Improve net recurring revenue",
    growth: 0.12,
    metrics: [revenueMetric("Recognized revenue", "Sum of paid invoice amounts by invoice date, in company currency."), { key: "invoices", name: "Paid invoices", description: "Count of paid invoices.", unit: "count", calc: { kind: "count", filters: [] } }],
    leadingIndicators: ["Activation", "Qualified pipeline", "Renewals due", "Expansion"],
    guardrails: ["Gross margin", "Refunds", "Churn"],
    grossMarginBps: 7000,
    departments: ["Revenue", "Customer success", "Finance", "Operations"],
    interventionTargetMajor: 10_000,
    examples: [
      { name: "Faster trial follow-up", hypothesis: "Reaching new trials within two days lifts trial-to-paid conversion.", overlapKey: "trial-conversion", spendMajor: 3_000, costMajor: 3_000, p: [0.25, 0.5, 0.25], incMajor: [2_000, 12_000, 24_000], moat: { mechanism: "Reusable lead-routing playbook", pCreatedRetained: 0.4, conditionalValueMajor: 18_000, horizonMonths: 18 } },
      { name: "Annual-plan offer at renewal", hypothesis: "A modest annual-prepay discount converts monthly renewals and reduces churn.", overlapKey: "renewal", spendMajor: 1_500, costMajor: 1_500, p: [0.3, 0.5, 0.2], incMajor: [1_000, 7_000, 13_000], moat: { mechanism: "Higher annual-prepay share", pCreatedRetained: 0.55, conditionalValueMajor: 9_000, horizonMonths: 12 } },
      { name: "Guided onboarding call", hypothesis: "A setup call in week one raises activation for larger accounts.", overlapKey: "activation", spendMajor: 2_500, costMajor: 2_500, p: [0.2, 0.55, 0.25], incMajor: [4_000, 9_000, 16_000], moat: { mechanism: "Onboarding script and activation dataset", pCreatedRetained: 0.6, conditionalValueMajor: 14_000, horizonMonths: 24 } },
    ],
    pastInitiatives: ["Referral credit pilot", "Partner webinar series", "Usage-based upsell prompt", "Security bundle", "Outbound to a new segment", "Pricing page test", "Annual prepay nudge", "Longer free trial"],
  },
  {
    model: "services",
    label: "Professional services",
    description: "Revenue from projects, retainers and billable time.",
    objectiveName: "Grow recognized gross profit",
    growth: 0.1,
    metrics: [revenueMetric("Billed revenue", "Sum of billed amounts by invoice date, in company currency."), { key: "invoices", name: "Invoices issued", description: "Count of invoices.", unit: "count", calc: { kind: "count", filters: [] } }],
    leadingIndicators: ["Qualified projects", "Proposal conversion", "Billable utilization"],
    guardrails: ["Delivery capacity", "Customer satisfaction"],
    grossMarginBps: 4500,
    departments: ["Delivery", "Business development", "Finance", "Operations"],
    interventionTargetMajor: 15_000,
    examples: [
      { name: "Proposal follow-up within 48 hours", hypothesis: "A structured follow-up after every proposal lifts win rate.", overlapKey: "proposal", spendMajor: 2_000, costMajor: 2_000, p: [0.25, 0.5, 0.25], incMajor: [3_000, 16_000, 30_000], moat: { mechanism: "Proposal library and win/loss dataset", pCreatedRetained: 0.5, conditionalValueMajor: 20_000, horizonMonths: 24 } },
      { name: "Fixed-fee packages", hypothesis: "Packaging common engagements at a fixed fee shortens sales cycles.", overlapKey: "packaging", spendMajor: 4_000, costMajor: 4_000, p: [0.3, 0.5, 0.2], incMajor: [0, 14_000, 28_000] },
      { name: "Utilization review cadence", hypothesis: "A weekly utilization review converts idle capacity into billable work.", overlapKey: "utilization", spendMajor: 1_000, costMajor: 1_000, p: [0.2, 0.6, 0.2], incMajor: [2_000, 8_000, 14_000], moat: { mechanism: "Capacity-planning model", pCreatedRetained: 0.5, conditionalValueMajor: 12_000, horizonMonths: 12 } },
    ],
    pastInitiatives: ["Industry newsletter", "Partner referral scheme", "Discovery workshop offer", "Retainer conversion", "Case-study campaign", "Rate card update", "Conference sponsorship", "Proposal template refresh"],
  },
  {
    model: "commerce",
    label: "Retail or commerce",
    description: "Revenue from orders across stores and online channels.",
    objectiveName: "Improve contribution margin",
    growth: 0.08,
    metrics: [revenueMetric("Net sales", "Sum of order amounts net of discounts, by order date, in company currency."), { key: "orders", name: "Orders", description: "Count of orders.", unit: "count", calc: { kind: "count", filters: [] } }],
    leadingIndicators: ["Conversion", "Average order value", "Repeat purchase"],
    guardrails: ["Returns", "Discounts", "Fulfillment cost", "Inventory"],
    grossMarginBps: 3800,
    departments: ["E-commerce", "Merchandising", "Operations", "Finance"],
    interventionTargetMajor: 8_000,
    examples: [
      { name: "Abandoned-cart recovery", hypothesis: "Two reminder messages recover a share of abandoned carts.", overlapKey: "checkout", spendMajor: 1_200, costMajor: 1_200, p: [0.2, 0.55, 0.25], incMajor: [1_500, 9_000, 17_000], moat: { mechanism: "Recovery sequence and cart-abandonment dataset", pCreatedRetained: 0.5, conditionalValueMajor: 10_000, horizonMonths: 12 } },
      { name: "Bundle offer on top sellers", hypothesis: "Bundling complementary items raises average order value.", overlapKey: "aov", spendMajor: 2_000, costMajor: 2_000, p: [0.3, 0.5, 0.2], incMajor: [500, 7_500, 15_000] },
      { name: "Free-shipping threshold test", hypothesis: "A threshold just above average basket lifts order value more than it costs.", overlapKey: "shipping", spendMajor: 3_000, costMajor: 3_000, p: [0.3, 0.45, 0.25], incMajor: [0, 10_000, 20_000] },
    ],
    pastInitiatives: ["Loyalty points launch", "Seasonal clearance", "Influencer pilot", "Same-day delivery trial", "Product page redesign", "Gift-card promotion", "Marketplace listing", "Email win-back"],
  },
];

export function templateFor(model: BusinessModel): BusinessTemplate {
  return BUSINESS_TEMPLATES.find((t) => t.model === model) ?? BUSINESS_TEMPLATES[0];
}

const LABELS = ["Downside", "Base", "Upside"] as const;
const KEYS = ["downside", "base", "upside"] as const;

/** No-change baseline plus each example as an alternative (incremental revenue against a zero baseline). */
export function exampleAlternatives(t: BusinessTemplate, asOf: string, digits = 2, examples = t.examples): AlternativeInput[] {
  const unit = 10 ** digits;
  const baseline: AlternativeInput = {
    id: "alt-baseline",
    name: "No change",
    isBaseline: true,
    hypothesis: "Keep the current process.",
    spendMinor: 0,
    timeToEffectDays: 0,
    assumptions: [],
    scenarios: KEYS.map((key, i) => ({ key, label: LABELS[i], probability: [0.25, 0.5, 0.25][i], revenueMinor: 0, actionCostMinor: 0 })),
  };
  return [
    baseline,
    ...examples.map((e, k) => ({
      id: `alt-${k + 1}`,
      name: e.name,
      isBaseline: false,
      hypothesis: e.hypothesis,
      spendMinor: Math.round(e.spendMajor * unit),
      timeToEffectDays: 21,
      overlapKey: e.overlapKey,
      assumptions: [
        { key: "probabilities", label: "Scenario probabilities", value: e.p.map((x) => Math.round(x * 100)).join(" / "), provenance: { source: "template estimate", asOf, origin: "estimated" as const } },
        { key: "lift", label: "Incremental revenue", value: e.incMajor.join(" / "), provenance: { source: "template estimate", asOf, origin: "estimated" as const } },
      ],
      moat: e.moat ? ({ mechanism: e.moat.mechanism, pCreatedRetained: e.moat.pCreatedRetained, conditionalValueMinor: Math.round(e.moat.conditionalValueMajor * unit), horizonMonths: e.moat.horizonMonths } satisfies MoatEstimate) : undefined,
      scenarios: KEYS.map((key, i) => ({ key, label: LABELS[i], probability: e.p[i], revenueMinor: Math.round(e.incMajor[i] * unit), actionCostMinor: Math.round(e.costMajor * unit) })),
    })),
  ];
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/** What an objective still needs before it may steer rankings (spec §2). */
export function objectiveReadiness(o: Objective, metric: MetricDefinition | undefined, rowCount: number): string[] {
  const missing: string[] = [];
  if (!o.ownerId) missing.push("owner");
  if (!metric || metric.source === "not mapped" || (metric.mapsFrom && rowCount === 0)) missing.push("source");
  if (!o.baseline) missing.push("baselinePeriod");
  if (!o.deadline) missing.push("deadline");
  if (o.direction === "increase" && !(o.targetValue > 0)) missing.push("target");
  return missing;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceInput {
  companyName: string;
  businessModel: BusinessModel;
  currency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  admin: { name: string; title: string };
  sampleData: boolean;
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** Field names that are invalid; empty when the input is acceptable. */
export function validateWorkspaceInput(i: WorkspaceInput): string[] {
  const bad: string[] = [];
  if (typeof i.companyName !== "string" || !i.companyName.trim() || i.companyName.length > 120) bad.push("companyName");
  if (!BUSINESS_TEMPLATES.some((t) => t.model === i.businessModel)) bad.push("businessModel");
  if (typeof i.currency !== "string" || !isCurrencyCode(i.currency)) bad.push("currency");
  if (typeof i.timezone !== "string" || !isTimezone(i.timezone)) bad.push("timezone");
  if (!Number.isInteger(i.fiscalYearStartMonth) || i.fiscalYearStartMonth < 1 || i.fiscalYearStartMonth > 12) bad.push("fiscalYearStartMonth");
  if (!i.admin || typeof i.admin.name !== "string" || !i.admin.name.trim() || i.admin.name.length > 120) bad.push("admin.name");
  if (!i.admin || typeof i.admin.title !== "string" || i.admin.title.length > 120) bad.push("admin.title");
  if (typeof i.sampleData !== "boolean") bad.push("sampleData");
  return bad;
}

export interface WorkspaceSlices {
  tenant: Tenant;
  members: Member[];
  profile: BusinessProfile;
  policy: PolicyVersion;
  metrics: MetricDefinition[];
  objectives: Objective[];
  rows: StoredRow[];
  imports: ImportRecord[];
  decisions: Decision[];
  evaluations: Evaluation[];
  approvals: Approval[];
  work: WorkLink[];
  evidence: Evidence[];
  outcomes: Outcome[];
  moats: MoatAsset[];
  forecasts: ForecastRecord[];
  outbox: OutboxAction[];
  audit: Omit<AuditEvent, "seq">[];
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "workspace"
  );
}

/** Builds a new tenant from a template. With sampleData, adds a team, history and decisions. */
export function buildWorkspace(input: WorkspaceInput, nowIso: string, newId: (prefix: string) => string): WorkspaceSlices {
  const bad = validateWorkspaceInput(input);
  if (bad.length) throw new Error(`invalid workspace input: ${bad.join(", ")}`);
  const t = templateFor(input.businessModel);
  const now = Date.parse(nowIso);
  const tenantId = newId("t");
  const digits = minorDigits(input.currency);
  const unit = 10 ** digits;
  const admin: Member = { id: newId("u"), tenantId, name: input.admin.name.trim(), title: input.admin.title.trim() || "Administrator", role: "admin", department: "Operations" };
  const out: WorkspaceSlices = {
    tenant: { id: tenantId, name: input.companyName.trim(), workspaceId: `ws-${slug(input.companyName)}-${tenantId.slice(-6).replace(/[^\w]/g, "")}`, compassWorkspace: null },
    members: [admin],
    profile: { tenantId, version: 1, name: input.companyName.trim(), businessModel: t.model, currency: input.currency, timezone: input.timezone, fiscalYearStartMonth: input.fiscalYearStartMonth, grossMarginBps: t.grossMarginBps, departments: t.departments, aiDataPolicy: "aggregates_only", createdAt: nowIso },
    policy: { tenantId, version: 1, createdAt: nowIso, createdBy: admin.id, evaluation: { maxLossProbability: 0.3, maxSpendMinor: 25_000 * unit, maxDownsideExposureMinor: 10_000 * unit, maxInputAgeDays: 45 }, financeApprovalOverMinor: 5_000 * unit, requireIndependentApprover: true },
    metrics: [],
    objectives: [],
    rows: [],
    imports: [],
    decisions: [],
    evaluations: [],
    approvals: [],
    work: [],
    evidence: [],
    outcomes: [],
    moats: [],
    forecasts: [],
    outbox: [],
    audit: [],
  };
  for (const m of t.metrics)
    out.metrics.push({ id: newId("met"), tenantId, version: 1, name: m.name, description: m.description, unit: m.unit, calc: m.calc, grain: "week", ownerId: admin.id, source: "not mapped", freshnessHours: 36, mapsFrom: "billing" });
  const primary = out.metrics[t.metrics.findIndex((m) => m.primary)];
  const goal = { basis: "incremental_revenue" as const, direction: "increase" as const, target: t.interventionTargetMajor * unit, label: `≥ ${t.interventionTargetMajor.toLocaleString("en-US")} ${input.currency} incremental revenue in 90 days` };
  const objective: Objective = {
    id: newId("obj"),
    tenantId,
    version: 1,
    name: t.objectiveName,
    metricId: primary.id,
    direction: "increase",
    baseline: null,
    targetValue: 0,
    deadline: iso(now + 13 * 7 * DAY),
    ownerId: admin.id,
    guardrails: [...t.guardrails],
    leadingIndicators: [...t.leadingIndicators],
    interventionGoal: goal,
    status: "draft",
    missing: [],
    createdAt: nowIso,
  };
  out.objectives.push(objective);
  out.audit.push({ id: newId("aud"), tenantId, actorId: admin.id, action: "workspace.created", resource: `tenant/${tenantId}`, beforeRevision: null, afterRevision: 1, correlationId: newId("cor"), at: nowIso, detail: `${t.label} template` });

  if (input.sampleData) addSample(out, t, now, unit, newId);
  objective.missing = objectiveReadiness(objective, primary, out.rows.length);
  objective.status = objective.missing.length ? "draft" : "active";
  return out;
}

// ---------------------------------------------------------------------------
// Sample data (generic, template-driven)
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLE_TEAM: { name: string; title: string; role: Role; department: string }[] = [
  { name: "Morgan Ellis", title: "Chief executive (sample)", role: "executive", department: "Leadership" },
  { name: "Jordan Reyes", title: "Growth lead (sample)", role: "lead", department: "Revenue" },
  { name: "Casey Kim", title: "Operator (sample)", role: "operator", department: "Revenue" },
  { name: "Taylor Brooks", title: "Finance reviewer (sample)", role: "finance", department: "Finance" },
  { name: "Robin Shah", title: "Internal audit (sample)", role: "auditor", department: "Finance" },
];

function addSample(w: WorkspaceSlices, t: BusinessTemplate, now: number, unit: number, newId: (p: string) => string): void {
  const tenantId = w.tenant.id;
  const team = SAMPLE_TEAM.map((m) => ({ ...m, id: newId("u"), tenantId }));
  w.members.push(...team);
  const [exec, lead, operator, finance] = team;
  const r = rng(7);

  // 26 weeks of records with a gentle upward trend.
  const importId = newId("imp");
  const lastSync = now - 6 * 3_600_000;
  const start = Math.floor(lastSync / DAY) * DAY - 26 * 7 * DAY;
  let n = 0;
  for (let wk = 0; wk < 26; wk++) {
    const count = 19 + Math.floor(r() * 6) + Math.floor(wk / 5);
    for (let k = 0; k < count; k++) {
      n++;
      const major = Math.round(900 + r() * 1500 + wk * 22);
      w.rows.push({ id: newId("row"), tenantId, importId, externalId: `S-${String(n).padStart(5, "0")}`, occurredAt: iso(start + wk * 7 * DAY + Math.floor(r() * 7 * DAY)), currency: w.profile.currency, amountMinor: major * unit, fields: { stage: "paid", segment: r() > 0.7 ? "large" : "small" } });
    }
  }
  w.imports.push({ id: importId, tenantId, actorId: w.members[0].id, source: "sample data", createdAt: iso(lastSync), imported: n, duplicates: 0, invalid: 0, missing: 0 });
  for (const m of w.metrics) m.source = "sample data";

  const o = w.objectives[0];
  const qEnd = Math.floor(lastSync / DAY) * DAY + DAY;
  const base = w.rows.filter((x) => Date.parse(x.occurredAt) >= qEnd - 13 * 7 * DAY).reduce((s, x) => s + x.amountMinor, 0);
  o.baseline = { value: base, periodStart: iso(qEnd - 13 * 7 * DAY), periodEnd: iso(qEnd) };
  o.targetValue = Math.round((base * (1 + t.growth)) / (1000 * unit)) * 1000 * unit;
  o.deadline = iso(qEnd + 13 * 7 * DAY);
  o.ownerId = lead.id;

  // Decisions in several lifecycle states.
  const make = (title: string, examples: ExampleIntervention[], created: number, path: DecisionState[]): { d: Decision; e: Evaluation } => {
    const asOf = iso(created);
    const alternatives = exampleAlternatives(t, asOf, Math.log10(unit), examples);
    const d: Decision = { id: newId("dec"), tenantId, objectiveId: o.id, title, hypothesis: examples[0].hypothesis, ownerId: lead.id, state: "Draft", revision: 1, alternatives, horizonDays: 90, cohortSize: 400, chosenAlternativeId: null, rationale: null, override: false, latestEvaluationId: null, cancelledReason: null, history: [{ state: "Draft", at: asOf, actorId: lead.id, revision: 1 }], createdAt: asOf, updatedAt: asOf };
    const snapshot = { decisionId: d.id, decisionRevision: 1, objectiveLabel: o.name, currency: w.profile.currency, horizonDays: 90, asOf: iso(created + 3_600_000), grossMarginBps: w.profile.grossMarginBps, cohortSize: 400, goal: o.interventionGoal, policy: w.policy.evaluation, alternatives: structuredClone(alternatives) };
    const result = evaluate(snapshot);
    const e: Evaluation = { id: newId("ev"), tenantId, decisionId: d.id, decisionRevision: 1, status: result.status, inputHash: hashSnapshot(snapshot), snapshot, result, evaluatorVersion: result.evaluatorVersion, modelProvenance: { evaluator: "deterministic", model: null, promptVersion: null }, policyVersion: 1, createdAt: snapshot.asOf, completedAt: snapshot.asOf, expiresAt: iso(created + 15 * DAY) };
    d.latestEvaluationId = e.id;
    path.forEach((s, i) => {
      const at = iso(created + (i + 1) * 2 * DAY);
      d.history.push({ state: s, at, actorId: s === "Approved" ? exec.id : lead.id, revision: 1 });
      d.state = s;
      d.updatedAt = at;
      if (s === "AwaitingApproval") {
        d.chosenAlternativeId = result.recommendationId && result.recommendationId !== "alt-baseline" ? result.recommendationId : "alt-1";
        d.rationale = "Highest expected contribution among eligible options.";
      }
      if (s === "Approved") w.approvals.push({ id: newId("appr"), tenantId, decisionId: d.id, evaluationId: e.id, decisionRevision: 1, approverId: exec.id, role: "executive", verdict: "approve", reason: "Within risk appetite.", policyRule: "one executive or finance approval", active: true, createdAt: at });
    });
    w.decisions.push(d);
    w.evaluations.push(e);
    for (const a of alternatives.filter((x) => x.moat && x.id === d.chosenAlternativeId))
      w.moats.push({ id: newId("moat"), tenantId, decisionId: d.id, mechanism: a.moat!.mechanism, ownerId: lead.id, horizonMonths: a.moat!.horizonMonths, stage: d.state === "Debriefed" ? "realized" : d.state === "Executing" ? "created" : "proposed", pCreatedRetained: a.moat!.pCreatedRetained, conditionalValueMinor: a.moat!.conditionalValueMinor, evidence: d.state === "Debriefed" ? ["Reused by a second team"] : [], realizedMinor: d.state === "Debriefed" ? Math.round(a.moat!.conditionalValueMinor * 0.6) : null });
    return { d, e };
  };
  const work = (dec: Decision, title: string, state: WorkLink["state"], at: number, compassTaskId: string): WorkLink => {
    const wl: WorkLink = { id: newId("work"), tenantId, decisionId: dec.id, actionId: `act-${dec.id}-r1`, compassProjectId: "default", compassTaskId, title, doneWhen: ["Delivered to the agreed cohort", "Completion evidence attached", "Comparison cohort held out"], assigneeId: operator.id, state, attempts: 1, lastError: null, blockedReason: null, createdAt: iso(at), updatedAt: iso(at + 2 * DAY) };
    w.work.push(wl);
    w.outbox.push({ actionId: wl.actionId, tenantId, decisionId: dec.id, decisionRevision: 1, approvalIds: w.approvals.filter((a) => a.decisionId === dec.id).map((a) => a.id), workId: wl.id, state: "done", attempts: 1, nextAttemptAt: wl.createdAt, lastError: null });
    return wl;
  };
  const [e0, e1, e2] = t.examples;
  make(`${t.objectiveName}: ${e0.name.toLowerCase()} or ${e1.name.toLowerCase()}`, [e0, e1], now - 6 * DAY, ["Evaluated", "AwaitingApproval"]);
  const b = make(e2.name, [e2], now - 16 * DAY, ["Evaluated", "AwaitingApproval", "Approved", "Executing"]);
  work(b.d, e2.name, "linked", now - 10 * DAY, "CMP-0042");
  const c = make(e1.name, [e1], now - 70 * DAY, ["Evaluated", "AwaitingApproval", "Approved", "Executing", "DeliveryReview", "Measuring"]);
  const cw = work(c.d, e1.name, "verified", now - 63 * DAY, "CMP-0031");
  w.evidence.push({ id: newId("evd"), tenantId, workId: cw.id, kind: "note", title: "Delivery log", digest: "a".repeat(64), sensitivity: "internal", authorId: operator.id, capturedAt: iso(now - 58 * DAY), status: "accepted", reviewNote: "Matches the delivery record." });
  const d = make(e0.name, [e0], now - 120 * DAY, ["Evaluated", "AwaitingApproval", "Approved", "Executing", "DeliveryReview", "Measuring", "Debriefed"]);
  work(d.d, e0.name, "verified", now - 113 * DAY, "CMP-0019");

  const vals = (count: number, mu: number, sd: number) => Array.from({ length: count }, () => Math.round((mu + (r() + r() + r() - 1.5) * 2 * sd) * unit));
  const outcome = (dec: { d: Decision; e: Evaluation }, method: "random_holdout" | "matched_cohort", treated: number[], comparison: number[], wStart: number, wEnd: number, status: Outcome["status"]): Outcome => {
    const m = measureOutcome(method, treated, comparison);
    const chosen = dec.e.result!.alternatives.find((a) => a.id === dec.d.chosenAlternativeId)!;
    return { id: newId("out"), tenantId, decisionId: dec.d.id, evaluationId: dec.e.id, metricId: o.metricId, metricVersion: 1, windowStart: iso(wStart), windowEnd: iso(wEnd), measurement: m, predicted: { evContributionMinor: chosen.evContributionMinor, evRevenueMinor: chosen.evRevenueMinor, pGoal: chosen.pGoal }, goalMet: m.incrementalTotalMinor >= o.interventionGoal.target, sourceRowIds: w.rows.filter((x) => Date.parse(x.occurredAt) >= wStart && Date.parse(x.occurredAt) < wEnd).slice(0, 400).map((x) => x.id), status, reviewerId: status === "verified" ? finance.id : null, reviewRationale: status === "verified" ? "Holdout assignment checked; no overlapping campaign." : null, next: status === "verified" ? "expand" : null, revisitOn: status === "verified" ? iso(now + 30 * DAY).slice(0, 10) : null, createdAt: iso(wEnd + DAY), reviewedAt: status === "verified" ? iso(wEnd + 3 * DAY) : null };
  };
  const scale = t.interventionTargetMajor / 10_000;
  w.outcomes.push(outcome(d, "random_holdout", vals(90, 160 * scale, 50 * scale), vals(90, 40 * scale, 45 * scale), now - 100 * DAY, now - 40 * DAY, "verified"), outcome(c, "matched_cohort", vals(60, 90 * scale, 35 * scale), vals(60, 50 * scale, 30 * scale), now - 56 * DAY, now - 2 * DAY, "pending_review"));

  const ps = [0.7, 0.55, 0.8, 0.6, 0.35, 0.5, 0.65, 0.4];
  const hits: (0 | 1)[] = [1, 0, 1, 1, 0, 1, 0, 0];
  t.pastInitiatives.forEach((title, i) => w.forecasts.push({ id: newId("fc"), tenantId, decisionTitle: title, p: ps[i % ps.length], outcome: hits[i % hits.length], at: iso(now - (300 - i * 25) * DAY) }));
}
