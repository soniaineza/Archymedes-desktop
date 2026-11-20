import type {
  Approval,
  Decision,
  EnterpriseState,
  Evaluation,
  MetricDefinition,
  Objective,
  Outcome,
  StoredRow,
  WorkLink,
} from "../../shared/enterprise/api-types";
import { evaluate } from "../../shared/enterprise/evaluator";
import { annualPlanAlternative, baselineAlternative, DEFAULT_POLICY, leadFollowUpAlternative } from "../../shared/enterprise/fixtures";
import { measureOutcome } from "../../shared/enterprise/measurement";
import type { AlternativeInput, DecisionState, MoatEstimate } from "../../shared/enterprise/types";
import { buildSnapshot, hashSnapshot } from "./snapshot";

/** Seeded identities, exported for tests and the local pilot sign-in. */
export const KIVU = {
  tenant: "t-kivu",
  ws: "ws-kivu",
  admin: "u-amara",
  exec: "u-eric",
  lead: "u-grace",
  operator: "u-jean",
  finance: "u-claire",
  auditor: "u-ines",
  objective: "obj-revenue",
  metric: "met-revenue",
} as const;

export const LAKE = { tenant: "t-lake", ws: "ws-lake", admin: "u-nadia", lead: "u-tom" } as const;

const DAY = 86_400_000;
const usd = (d: number) => Math.round(d * 100);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;

function genRows(tenantId: string, currency: string, weeks: number, endMs: number, seed: number, scale: number): StoredRow[] {
  const r = rng(seed);
  const rows: StoredRow[] = [];
  const start = dayStart(endMs) - weeks * 7 * DAY;
  let n = 0;
  for (let w = 0; w < weeks; w++) {
    const count = 19 + Math.floor(r() * 6) + Math.floor(w / 5);
    for (let k = 0; k < count; k++) {
      n++;
      const at = start + w * 7 * DAY + Math.floor(r() * 7 * DAY);
      const seg = r();
      const plan = r() < 0.2 + w * 0.005 ? "annual" : "monthly";
      const dollars = (900 + r() * 1500 + w * 22) * scale * (seg > 0.9 ? 2.4 : seg > 0.6 ? 1.5 : 1);
      rows.push({
        id: `${tenantId}-row-${n}`,
        tenantId,
        importId: `${tenantId}-imp-seed`,
        externalId: `INV-${String(n).padStart(4, "0")}`,
        occurredAt: iso(at),
        currency,
        amountMinor: Math.round(dollars * 100),
        fields: { stage: "paid", plan, segment: seg > 0.9 ? "enterprise" : seg > 0.6 ? "mid" : "smb", account: `ACC-${String(1 + Math.floor(r() * 420)).padStart(3, "0")}` },
      });
    }
  }
  return rows;
}

function alt(id: string, name: string, hypothesis: string, inc: [number, number, number], p: [number, number, number], cost: number, asOf: string, overlapKey: string, moat?: MoatEstimate): AlternativeInput {
  const base = baselineAlternative(asOf);
  return {
    id,
    name,
    isBaseline: false,
    hypothesis,
    spendMinor: usd(cost),
    timeToEffectDays: 21,
    overlapKey,
    moat,
    assumptions: [
      { key: "lift", label: "Revenue lift range", value: inc.map((x) => `$${x.toLocaleString("en-US")}`).join(" / "), provenance: { source: "revenue lead estimate", asOf, origin: "estimated" } },
      { key: "cost", label: "Action cost", value: `$${cost.toLocaleString("en-US")}`, provenance: { source: "team capacity plan", asOf, origin: "estimated" } },
    ],
    scenarios: base.scenarios.map((s, i) => ({ ...s, probability: p[i], revenueMinor: s.revenueMinor! + usd(inc[i]), actionCostMinor: usd(cost) })),
  };
}

export function seedState(nowIso: string): EnterpriseState {
  const now = Date.parse(nowIso);
  const st: EnterpriseState = {
    schemaVersion: 1,
    seq: 0,
    tenants: [
      { id: KIVU.tenant, name: "Kivu Cloud", workspaceId: KIVU.ws, compassWorkspace: null },
      { id: LAKE.tenant, name: "Lakeside Retail", workspaceId: LAKE.ws, compassWorkspace: null },
    ],
    members: [
      { id: KIVU.admin, tenantId: KIVU.tenant, name: "Amara Uwase", title: "RevOps admin", role: "admin", department: "Operations" },
      { id: KIVU.exec, tenantId: KIVU.tenant, name: "Eric Mugisha", title: "Chief executive", role: "executive", department: "Leadership" },
      { id: KIVU.lead, tenantId: KIVU.tenant, name: "Grace Ishimwe", title: "Head of revenue", role: "lead", department: "Revenue" },
      { id: KIVU.operator, tenantId: KIVU.tenant, name: "Jean Habimana", title: "Sales development", role: "operator", department: "Revenue" },
      { id: KIVU.finance, tenantId: KIVU.tenant, name: "Claire Mukamana", title: "Finance reviewer", role: "finance", department: "Finance" },
      { id: KIVU.auditor, tenantId: KIVU.tenant, name: "Ines Kayitesi", title: "Internal audit", role: "auditor", department: "Finance" },
      { id: LAKE.admin, tenantId: LAKE.tenant, name: "Nadia Weber", title: "Commerce ops", role: "admin", department: "Operations" },
      { id: LAKE.lead, tenantId: LAKE.tenant, name: "Tom Becker", title: "Growth lead", role: "lead", department: "Growth" },
    ],
    profiles: [
      { tenantId: KIVU.tenant, version: 1, name: "Kivu Cloud", businessModel: "subscription", currency: "USD", timezone: "Africa/Kigali", fiscalYearStartMonth: 1, grossMarginBps: 6000, departments: ["Revenue", "Finance", "Operations", "Leadership"], aiDataPolicy: "aggregates_only", createdAt: iso(now - 200 * DAY) },
      { tenantId: LAKE.tenant, version: 1, name: "Lakeside Retail", businessModel: "commerce", currency: "EUR", timezone: "Europe/Berlin", fiscalYearStartMonth: 4, grossMarginBps: 3800, departments: ["Growth", "Operations"], aiDataPolicy: "none", createdAt: iso(now - 90 * DAY) },
    ],
    policies: [
      { tenantId: KIVU.tenant, version: 1, createdAt: iso(now - 200 * DAY), createdBy: KIVU.admin, evaluation: DEFAULT_POLICY, financeApprovalOverMinor: usd(5_000), requireIndependentApprover: true },
      { tenantId: LAKE.tenant, version: 1, createdAt: iso(now - 90 * DAY), createdBy: LAKE.admin, evaluation: { ...DEFAULT_POLICY, maxLossProbability: 0.15 }, financeApprovalOverMinor: usd(2_000), requireIndependentApprover: true },
    ],
    metrics: [],
    objectives: [],
    decisions: [],
    evaluations: [],
    approvals: [],
    work: [],
    evidence: [],
    outcomes: [],
    moats: [],
    audit: [],
    events: [],
    outbox: [],
    rows: [],
    imports: [],
    forecasts: [],
    idempotency: [],
    jobs: [],
  };

  // ---- data ----
  const lastSync = now - 6 * 3_600_000;
  st.rows.push(...genRows(KIVU.tenant, "USD", 26, lastSync, 7, 1), ...genRows(LAKE.tenant, "EUR", 12, lastSync, 11, 0.4));
  for (const t of [KIVU.tenant, LAKE.tenant]) {
    const n = st.rows.filter((r) => r.tenantId === t).length;
    st.imports.push({ id: `${t}-imp-seed`, tenantId: t, actorId: t === KIVU.tenant ? KIVU.admin : LAKE.admin, source: "billing.csv", createdAt: iso(lastSync), imported: n, duplicates: 0, invalid: 0, missing: 0 });
  }

  const paid = [{ field: "stage", equals: "paid" }];
  const metrics: MetricDefinition[] = [
    { id: KIVU.metric, tenantId: KIVU.tenant, version: 1, name: "Recognized revenue", description: "Sum of paid invoice amounts, by invoice date, company currency.", unit: "money", calc: { kind: "sum", field: "amount", filters: paid }, grain: "week", ownerId: KIVU.finance, source: "billing.csv · Stripe invoice export", freshnessHours: 36 },
    { id: "met-annual-share", tenantId: KIVU.tenant, version: 2, name: "Annual-plan share", description: "Paid invoices on an annual plan ÷ all paid invoices.", unit: "ratio", calc: { kind: "ratio", numerator: { kind: "count", filters: [...paid, { field: "plan", equals: "annual" }] }, denominator: { kind: "count", filters: paid } }, grain: "week", ownerId: KIVU.lead, source: "billing.csv · plan column", freshnessHours: 36 },
    { id: "met-refund-rate", tenantId: KIVU.tenant, version: 1, name: "Refund rate", description: "Refunded invoices ÷ refund-eligible invoices. No refund source is mapped yet.", unit: "ratio", calc: { kind: "ratio", numerator: { kind: "count", filters: [{ field: "stage", equals: "refunded" }] }, denominator: { kind: "count", filters: [{ field: "stage", equals: "refund_eligible" }] } }, grain: "week", ownerId: KIVU.finance, source: "not mapped", freshnessHours: 36 },
    { id: "met-lake-revenue", tenantId: LAKE.tenant, version: 1, name: "Net sales", description: "Sum of paid orders.", unit: "money", calc: { kind: "sum", field: "amount", filters: paid }, grain: "week", ownerId: LAKE.admin, source: "orders.csv", freshnessHours: 24 },
  ];
  st.metrics.push(...metrics);

  const weekSum = (tenant: string, from: number, to: number) => st.rows.filter((r) => r.tenantId === tenant && Date.parse(r.occurredAt) >= from && Date.parse(r.occurredAt) < to).reduce((s, r) => s + r.amountMinor, 0);
  const qEnd = dayStart(lastSync) + DAY;
  const baselineRevenue = weekSum(KIVU.tenant, qEnd - 13 * 7 * DAY, qEnd);
  const goal = { basis: "incremental_revenue" as const, direction: "increase" as const, target: usd(10_000), label: "≥ $10,000 incremental revenue in 90 days" };
  const objectives: Objective[] = [
    { id: KIVU.objective, tenantId: KIVU.tenant, version: 1, name: "Grow recognized revenue 12% next quarter", metricId: KIVU.metric, direction: "increase", baseline: { value: baselineRevenue, periodStart: iso(qEnd - 13 * 7 * DAY), periodEnd: iso(qEnd) }, targetValue: Math.round((baselineRevenue * 1.12) / 100_000) * 100_000, deadline: iso(qEnd + 13 * 7 * DAY), ownerId: KIVU.lead, guardrails: ["Gross margin ≥ 58%", "Refund rate ≤ 2%"], leadingIndicators: ["Trial activations", "Qualified pipeline", "Renewals due"], interventionGoal: goal, status: "active", missing: [], createdAt: iso(now - 30 * DAY) },
    { id: "obj-annual-share", tenantId: KIVU.tenant, version: 1, name: "Raise annual-plan share to 35%", metricId: "met-annual-share", direction: "increase", baseline: { value: 0.27, periodStart: iso(qEnd - 13 * 7 * DAY), periodEnd: iso(qEnd) }, targetValue: 0.35, deadline: iso(qEnd + 13 * 7 * DAY), ownerId: KIVU.lead, guardrails: ["Discount ≤ 10%"], leadingIndicators: ["Renewals offered annual"], interventionGoal: goal, status: "active", missing: [], createdAt: iso(now - 30 * DAY) },
    { id: "obj-refunds", tenantId: KIVU.tenant, version: 1, name: "Keep refund rate under 2%", metricId: "met-refund-rate", direction: "decrease", baseline: null, targetValue: 0.02, deadline: null, ownerId: null, guardrails: [], leadingIndicators: [], interventionGoal: goal, status: "draft", missing: ["owner", "source", "baselinePeriod", "deadline"], createdAt: iso(now - 3 * DAY) },
    { id: "obj-lake", tenantId: LAKE.tenant, version: 1, name: "Improve contribution margin", metricId: "met-lake-revenue", direction: "increase", baseline: { value: weekSum(LAKE.tenant, qEnd - 12 * 7 * DAY, qEnd), periodStart: iso(qEnd - 12 * 7 * DAY), periodEnd: iso(qEnd) }, targetValue: 1, deadline: iso(qEnd + 90 * DAY), ownerId: LAKE.lead, guardrails: ["Returns ≤ 8%"], leadingIndicators: ["Conversion", "AOV"], interventionGoal: { ...goal, label: "≥ €4,000 incremental revenue" }, status: "active", missing: [], createdAt: iso(now - 20 * DAY) },
  ];
  st.objectives.push(...objectives);

  // ---- decisions ----
  const obj = objectives[0];
  let n = 0;
  const audit = (actorId: string, action: string, resource: string, at: number, rev: number | null = null) =>
    st.audit.push({ id: `aud-seed-${++n}`, tenantId: KIVU.tenant, seq: ++st.seq, actorId, action, resource, beforeRevision: rev, afterRevision: rev, correlationId: `seed-${n}`, at: iso(at), detail: null });

  const makeDecision = (id: string, title: string, hypothesis: string, alts: AlternativeInput[], created: number, path: DecisionState[], chosen: string): { d: Decision; e: Evaluation } => {
    const d: Decision = { id, tenantId: KIVU.tenant, objectiveId: obj.id, title, hypothesis, ownerId: KIVU.lead, state: "Draft", revision: 1, alternatives: alts, horizonDays: 90, cohortSize: 420, chosenAlternativeId: null, rationale: null, override: false, latestEvaluationId: null, cancelledReason: null, history: [{ state: "Draft", at: iso(created), actorId: KIVU.lead, revision: 1 }], createdAt: iso(created), updatedAt: iso(created) };
    const { snapshot, policyVersion } = buildSnapshot(st, d, obj, iso(created + 3_600_000));
    const result = evaluate(snapshot);
    const e: Evaluation = { id: `ev-${id}`, tenantId: KIVU.tenant, decisionId: id, decisionRevision: 1, status: result.status, inputHash: hashSnapshot(snapshot), snapshot, result, evaluatorVersion: result.evaluatorVersion, modelProvenance: { evaluator: "deterministic", model: null, promptVersion: null }, policyVersion, createdAt: iso(created + 3_600_000), completedAt: iso(created + 3_600_500), expiresAt: iso(created + 15 * DAY) };
    st.evaluations.push(e);
    d.latestEvaluationId = e.id;
    audit(KIVU.lead, "decision.created", `decision/${id}`, created, 1);
    audit(KIVU.lead, "decision.evaluated", `decision/${id}`, created + 3_600_500, 1);
    path.forEach((s, i) => {
      const at = created + (i + 1) * 2 * DAY;
      d.history.push({ state: s, at: iso(at), actorId: s === "Approved" ? KIVU.exec : KIVU.lead, revision: 1 });
      d.state = s;
      d.updatedAt = iso(at);
      if (s === "AwaitingApproval") {
        d.chosenAlternativeId = chosen;
        d.rationale = "Highest expected contribution among eligible options; builds a reusable asset.";
      }
      if (s === "Approved") {
        const a: Approval = { id: `appr-${id}`, tenantId: KIVU.tenant, decisionId: id, evaluationId: e.id, decisionRevision: 1, approverId: KIVU.exec, role: "executive", verdict: "approve", reason: "Within risk appetite.", policyRule: "one executive or finance approval", active: true, createdAt: iso(at) };
        st.approvals.push(a);
        audit(KIVU.exec, "decision.approved", `decision/${id}`, at, 1);
      }
    });
    st.decisions.push(d);
    return { d, e };
  };

  const t0 = now - 70 * DAY;
  const asOf = (ms: number) => iso(ms);

  // A — awaiting approval: the §6 worked example plus a second candidate.
  const aAt = now - 2 * DAY;
  makeDecision("dec-lead-follow-up", "Lift trial-to-paid conversion", "Faster human follow-up converts more inbound trials.", [baselineAlternative(asOf(aAt)), leadFollowUpAlternative(asOf(aAt)), annualPlanAlternative(asOf(aAt))], aAt - 4 * DAY, ["Evaluated", "AwaitingApproval"], "alt-lead-follow-up");

  // B — executing, linked Compass work.
  const bAt = now - 16 * DAY;
  const b = makeDecision("dec-onboarding", "Guided onboarding for mid-market trials", "A 30-minute setup call in week one raises mid-market activation.", [baselineAlternative(asOf(bAt)), alt("alt-onboarding", "Guided onboarding call", "Setup call in week one.", [4_000, 9_000, 16_000], [0.2, 0.55, 0.25], 2_500, asOf(bAt), "activation", { mechanism: "Onboarding script + activation dataset", pCreatedRetained: 0.6, conditionalValueMinor: usd(14_000), horizonMonths: 24 })], bAt, ["Evaluated", "AwaitingApproval", "Approved", "Executing"], "alt-onboarding");
  const bWork: WorkLink = { id: "work-onboarding", tenantId: KIVU.tenant, decisionId: b.d.id, actionId: "act-dec-onboarding-r1", compassProjectId: "revenue-ops", compassTaskId: "CMP-0042", title: "Run guided onboarding for 60 mid-market trials", doneWhen: ["60 trials offered a call", "Call notes logged in CRM", "Activation flag captured per account"], assigneeId: KIVU.operator, state: "linked", attempts: 1, lastError: null, blockedReason: null, createdAt: iso(bAt + 6 * DAY), updatedAt: iso(bAt + 8 * DAY) };
  st.work.push(bWork);
  st.outbox.push({ actionId: bWork.actionId, tenantId: KIVU.tenant, decisionId: b.d.id, decisionRevision: 1, approvalIds: ["appr-dec-onboarding"], workId: bWork.id, state: "done", attempts: 1, nextAttemptAt: bWork.createdAt, lastError: null });

  // C — measuring, outcome awaiting finance review.
  const cAt = t0;
  const c = makeDecision("dec-dunning", "Smart dunning retries", "Retrying failed cards on payday recovers involuntary churn.", [baselineAlternative(asOf(cAt)), alt("alt-dunning", "Payday-aware card retries", "Retry on local paydays.", [1_000, 5_000, 8_000], [0.2, 0.6, 0.2], 800, asOf(cAt), "billing")], cAt, ["Evaluated", "AwaitingApproval", "Approved", "Executing", "DeliveryReview", "Measuring"], "alt-dunning");
  const cWork: WorkLink = { ...bWork, id: "work-dunning", decisionId: c.d.id, actionId: "act-dec-dunning-r1", compassTaskId: "CMP-0031", title: "Ship payday-aware retry schedule", doneWhen: ["Retry schedule live for all failed cards", "Recovery events tagged"], state: "verified", createdAt: iso(cAt + 7 * DAY), updatedAt: iso(cAt + 14 * DAY) };
  st.work.push(cWork);
  st.evidence.push({ id: "evd-dunning-1", tenantId: KIVU.tenant, workId: cWork.id, kind: "link", title: "Retry schedule deploy log", digest: "9f2c".padEnd(64, "0"), sensitivity: "internal", authorId: KIVU.operator, capturedAt: iso(cAt + 12 * DAY), status: "accepted", reviewNote: "Verified against billing events." });

  // D — debriefed with a verified outcome and a realized moat asset.
  const dAt = now - 120 * DAY;
  const d = makeDecision("dec-win-back", "Win-back offer for churned SMB", "A one-month credit brings back churned small accounts.", [baselineAlternative(asOf(dAt)), alt("alt-win-back", "One-month credit win-back", "Email + credit to churned SMB.", [0, 6_000, 11_000], [0.3, 0.5, 0.2], 1_500, asOf(dAt), "churn", { mechanism: "Churn-reason taxonomy + win-back sequence", pCreatedRetained: 0.5, conditionalValueMinor: usd(8_000), horizonMonths: 12 })], dAt, ["Evaluated", "AwaitingApproval", "Approved", "Executing", "DeliveryReview", "Measuring", "Debriefed"], "alt-win-back");
  st.work.push({ ...bWork, id: "work-win-back", decisionId: d.d.id, actionId: "act-dec-win-back-r1", compassTaskId: "CMP-0019", title: "Send win-back sequence to 180 churned SMB accounts", doneWhen: ["Sequence sent", "Credits applied"], state: "verified", createdAt: iso(dAt + 7 * DAY), updatedAt: iso(dAt + 20 * DAY) });

  const r = rng(99);
  const values = (n: number, mu: number, sd: number) => Array.from({ length: n }, () => Math.round(mu + (r() + r() + r() - 1.5) * 2 * sd));
  const mkOutcome = (id: string, dec: { d: Decision; e: Evaluation }, method: "random_holdout" | "matched_cohort", t: number[], cmp: number[], wStart: number, wEnd: number, status: Outcome["status"]): Outcome => {
    const m = measureOutcome(method, t, cmp);
    const chosen = dec.e.result!.alternatives.find((a) => a.id === dec.d.chosenAlternativeId)!;
    return {
      id,
      tenantId: KIVU.tenant,
      decisionId: dec.d.id,
      evaluationId: dec.e.id,
      metricId: KIVU.metric,
      metricVersion: 1,
      windowStart: iso(wStart),
      windowEnd: iso(wEnd),
      measurement: m,
      predicted: { evContributionMinor: chosen.evContributionMinor, evRevenueMinor: chosen.evRevenueMinor, pGoal: chosen.pGoal },
      goalMet: m.incrementalTotalMinor >= goal.target,
      sourceRowIds: st.rows.filter((x) => x.tenantId === KIVU.tenant && Date.parse(x.occurredAt) >= wStart && Date.parse(x.occurredAt) < wEnd).slice(0, 400).map((x) => x.id),
      status,
      reviewerId: status === "verified" ? KIVU.finance : null,
      reviewRationale: status === "verified" ? "Holdout assignment checked; no overlapping campaign." : null,
      next: status === "verified" ? "expand" : null,
      revisitOn: status === "verified" ? iso(now + 30 * DAY).slice(0, 10) : null,
      createdAt: iso(wEnd + DAY),
      reviewedAt: status === "verified" ? iso(wEnd + 3 * DAY) : null,
    };
  };
  st.outcomes.push(
    mkOutcome("out-win-back", d, "random_holdout", values(90, 9_400, 3_000), values(90, 3_100, 2_800), dAt + 20 * DAY, dAt + 80 * DAY, "verified"),
    mkOutcome("out-dunning", c, "matched_cohort", values(60, 4_200, 1_900), values(60, 2_600, 1_700), cAt + 14 * DAY, now - 2 * DAY, "pending_review"),
  );

  st.moats.push(
    { id: "moat-win-back", tenantId: KIVU.tenant, decisionId: d.d.id, mechanism: "Churn-reason taxonomy + win-back sequence", ownerId: KIVU.lead, horizonMonths: 12, stage: "realized", pCreatedRetained: 0.5, conditionalValueMinor: usd(8_000), evidence: ["Taxonomy reused by support (Oct)", "Sequence re-run for Q4 cohort"], realizedMinor: usd(5_200) },
    { id: "moat-onboarding", tenantId: KIVU.tenant, decisionId: b.d.id, mechanism: "Onboarding script + activation dataset", ownerId: KIVU.lead, horizonMonths: 24, stage: "created", pCreatedRetained: 0.6, conditionalValueMinor: usd(14_000), evidence: ["Script v1 in playbook"], realizedMinor: null },
    { id: "moat-lead-follow-up", tenantId: KIVU.tenant, decisionId: "dec-lead-follow-up", mechanism: "Reusable lead-routing playbook + labelled response-time dataset", ownerId: KIVU.lead, horizonMonths: 18, stage: "proposed", pCreatedRetained: 0.4, conditionalValueMinor: usd(18_000), evidence: [], realizedMinor: null },
  );

  // Prior quarters' forecasts for calibration (P(goal) stored before action, outcome after).
  const history: [string, number, 0 | 1][] = [
    ["Referral credit pilot", 0.7, 1],
    ["Partner webinar series", 0.55, 0],
    ["Usage-based upsell prompt", 0.8, 1],
    ["Enterprise SSO bundle", 0.6, 1],
    ["Cold outbound to fintechs", 0.35, 0],
    ["Price page A/B", 0.5, 1],
    ["Annual prepay nudge", 0.65, 0],
    ["Trial length 14→21 days", 0.4, 0],
  ];
  history.forEach(([title, p, o], i) => st.forecasts.push({ id: `fc-${i}`, tenantId: KIVU.tenant, decisionTitle: title, p, outcome: o, at: iso(now - (300 - i * 25) * DAY) }));
  const win = st.outcomes[0];
  st.forecasts.push({ id: "fc-win-back", tenantId: KIVU.tenant, decisionTitle: "Win-back offer for churned SMB", p: win.predicted.pGoal ?? 0.5, outcome: win.goalMet ? 1 : 0, at: win.reviewedAt! });

  return st;
}
