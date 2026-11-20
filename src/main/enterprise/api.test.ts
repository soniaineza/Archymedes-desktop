/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are inspected structurally in tests */
import { beforeEach, describe, expect, it } from "vitest";
import { annualPlanAlternative, baselineAlternative, leadFollowUpAlternative } from "../../shared/enterprise/fixtures";
import type { EntRequest, EntResponse } from "../../shared/enterprise/api-types";
import { EnterpriseApi } from "./api";
import { LocalCompassAdapter } from "./compass-adapter";
import { KIVU, LAKE, seedState } from "./seed";

const ASOF = "2026-11-18T09:00:00.000Z";
let clock = Date.parse("2026-11-20T08:00:00.000Z");
const now = () => new Date(clock).toISOString();

let compass: LocalCompassAdapter;
let api: EnterpriseApi;

beforeEach(() => {
  clock = Date.parse("2026-11-20T08:00:00.000Z");
  compass = new LocalCompassAdapter();
  api = new EnterpriseApi(seedState(now()), { now, compass });
});

const ws = (w: string, path: string) => `/v1/workspaces/${w}${path}`;
async function call<T = any>(actor: string, req: EntRequest): Promise<EntResponse<T>> {
  return (await api.handle(actor, req)) as EntResponse<T>;
}
const get = <T = any>(actor: string, path: string, w: string = KIVU.ws) => call<T>(actor, { method: "GET", path: ws(w, path) });
const post = <T = any>(actor: string, path: string, body: unknown, extra: Partial<EntRequest> = {}, w: string = KIVU.ws) =>
  call<T>(actor, { method: "POST", path: ws(w, path), body, ...extra });

async function newDecision(alts = [baselineAlternative(ASOF), leadFollowUpAlternative(ASOF)]) {
  const r = await post(KIVU.lead, "/decisions", {
    objectiveId: KIVU.objective,
    title: "Lift trial conversion",
    hypothesis: "Faster follow-up converts more trials.",
    horizonDays: 90,
    cohortSize: 420,
    alternatives: alts,
  });
  expect(r.status).toBe(201);
  return r.body.decision as { id: string; revision: number };
}

async function evaluateDecision(id: string) {
  const r = await post(KIVU.lead, `/decisions/${id}/evaluations`, {});
  expect(r.status).toBe(202);
  await api.runJobs();
  const e = await get(KIVU.lead, `/evaluations/${r.body.evaluationId}`);
  expect(e.status).toBe(200);
  return e.body.evaluation;
}

async function approve(id: string, evaluationId: string, revision: number, actor: string = KIVU.exec, key = `appr-${id}-${actor}`) {
  return post(actor, `/decisions/${id}/approvals`, { evaluationId, verdict: "approve", reason: "Within risk appetite." }, { idempotencyKey: key, ifRevision: revision });
}

describe("first engineering ticket — end-to-end revenue workflow (§12)", () => {
  it("goal → Orion comparison → approval → one Compass task → evidence review → measured debrief", async () => {
    const d = await newDecision([baselineAlternative(ASOF), leadFollowUpAlternative(ASOF), annualPlanAlternative(ASOF)]);
    const evaluation = await evaluateDecision(d.id);
    expect(evaluation.status).toBe("complete");
    expect(evaluation.result.recommendationId).toBe("alt-lead-follow-up");
    expect(evaluation.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluation.evaluatorVersion).toBeTruthy();

    // Submitting the choice moves it to approval.
    const choose = await post(KIVU.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "Highest EV; moat upside." }, { ifRevision: d.revision });
    expect(choose.status).toBe(200);
    expect(choose.body.decision.state).toBe("AwaitingApproval");

    const a = await approve(d.id, evaluation.id, d.revision);
    expect(a.status).toBe(201);
    expect(a.body.decision.state).toBe("Approved");

    await api.drainOutbox();
    const work = await get(KIVU.lead, `/decisions/${d.id}/work`);
    expect(work.body.work).toHaveLength(1);
    const w = work.body.work[0];
    expect(w.compassTaskId).toMatch(/^CMP-/);
    expect(w.state).toBe("linked");
    expect((await get(KIVU.lead, `/decisions/${d.id}`)).body.decision.state).toBe("Executing");

    const ev = await post(KIVU.operator, `/work/${w.id}/evidence`, { title: "Call log export", kind: "file", digest: "a".repeat(64), sensitivity: "internal" });
    expect(ev.status).toBe(201);
    const dr = await post(KIVU.finance, `/work/${w.id}/delivery-review`, { verdict: "verify", reason: "Log matches 412 accounts." });
    expect(dr.status).toBe(200);
    expect(dr.body.decision.state).toBe("Measuring");

    const out = await post(KIVU.lead, `/decisions/${d.id}/outcomes`, {
      method: "random_holdout",
      treatedValues: [3000, 4000, 5000, 2000],
      comparisonValues: [1000, 2000, 1500, 1500],
      windowStart: "2026-11-20T00:00:00.000Z",
      windowEnd: "2027-02-18T00:00:00.000Z",
    });
    expect(out.status).toBe(201);
    expect(out.body.outcome.measurement.attribution).toBe("causal");
    expect(out.body.outcome.metricVersion).toBeGreaterThanOrEqual(1);
    expect(out.body.outcome.evaluationId).toBe(evaluation.id);

    const rev = await post(KIVU.finance, `/outcomes/${out.body.outcome.id}/review`, { verdict: "verified", rationale: "Holdout clean.", next: "expand", revisitOn: "2027-03-01" });
    expect(rev.status).toBe(200);
    expect(rev.body.decision.state).toBe("Debriefed");
  });

  it("second run: the same action is blocked at a 20% loss threshold", async () => {
    const p = await post(KIVU.admin, "/policy", { maxLossProbability: 0.2 });
    expect(p.status).toBe(201);
    expect(p.body.policy.version).toBeGreaterThan(1);
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    expect(e.result.recommendationId).toBeNull();
    const choose = await post(KIVU.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "Try anyway" }, { ifRevision: d.revision });
    expect(choose.status).toBe(403);
    expect(choose.body.error.code).toBe("policy_gate");
  });
});

describe("acceptance checks (§11)", () => {
  it("tenants with identical external CRM IDs cannot see, mutate or infer each other's records", async () => {
    const lakeObj = (await get(LAKE.admin, "/objectives", LAKE.ws)).body.objectives[0];
    // Kivu actor addressing Lake's workspace: indistinguishable from nonexistent.
    expect((await get(KIVU.admin, "/objectives", LAKE.ws)).status).toBe(404);
    expect((await get(KIVU.admin, "/today", "ws-does-not-exist")).status).toBe(404);
    // Kivu actor referencing Lake's objective id inside Kivu's workspace.
    const r = await post(KIVU.lead, "/decisions", { objectiveId: lakeObj.id, title: "x", hypothesis: "", horizonDays: 90, cohortSize: 1, alternatives: [baselineAlternative(ASOF), leadFollowUpAlternative(ASOF)] });
    expect(r.status).toBe(404);
    // Both tenants hold INV-0001; importing it into Kivu dedupes only against Kivu.
    const kivuRows = (await get(KIVU.admin, "/source-rows")).body.total;
    const imp = await post(KIVU.admin, "/imports", { csv: "invoice_id,date,amount\nINV-NEW-1,2026-11-19,10.00", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", defaultCurrency: "USD", extra: {} }, dryRun: false });
    expect(imp.status).toBe(201);
    expect((await get(KIVU.admin, "/source-rows")).body.total).toBe(kivuRows + 1);
    expect((await get(LAKE.admin, "/source-rows", LAKE.ws)).body.rows.some((x: { externalId: string }) => x.externalId === "INV-NEW-1")).toBe(false);
    const dup = await post(LAKE.admin, "/imports", { csv: "invoice_id,date,amount\nINV-0001,2026-11-19,10.00", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", defaultCurrency: "EUR", extra: {} }, dryRun: true }, {}, LAKE.ws);
    expect(dup.body.preview.duplicates).toHaveLength(1); // its own INV-0001, not Kivu's
  });

  it("a replayed import preserves one business effect", async () => {
    const body = { csv: "invoice_id,date,amount\nINV-R-1,2026-11-19,99.00", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", defaultCurrency: "USD", extra: {} }, dryRun: false };
    const before = (await get(KIVU.admin, "/source-rows")).body.total;
    await post(KIVU.admin, "/imports", body);
    const again = await post(KIVU.admin, "/imports", body);
    expect(again.status).toBe(201);
    expect(again.body.imported).toBe(0);
    expect((await get(KIVU.admin, "/source-rows")).body.total).toBe(before + 1);
  });

  it("an import in a different currency than the company is rejected per row", async () => {
    const r = await post(KIVU.admin, "/imports", { csv: "invoice_id,date,amount,currency\nINV-X,2026-11-19,5,EUR", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", currency: "currency", defaultCurrency: "USD", extra: {} }, dryRun: true });
    expect(r.body.preview.invalid[0].reason).toMatch(/currency/i);
  });

  it("a repeated approval request is idempotent; a conflicting reuse of the key is 409", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(KIVU.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    const first = await approve(d.id, e.id, d.revision, KIVU.exec, "k1");
    const replay = await approve(d.id, e.id, d.revision, KIVU.exec, "k1");
    expect(replay).toEqual(first);
    const conflict = await post(KIVU.exec, `/decisions/${d.id}/approvals`, { evaluationId: e.id, verdict: "reject", reason: "changed my mind" }, { idempotencyKey: "k1", ifRevision: d.revision });
    expect(conflict.status).toBe(409);
    await api.drainOutbox();
    await api.drainOutbox();
    expect(compass.taskCount(KIVU.ws)).toBe(1);
  });

  it("a Compass timeout after the write reconciles by action ID: one task", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(KIVU.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    compass.failNext("timeout_after_write");
    await approve(d.id, e.id, d.revision);
    await api.drainOutbox();
    let work = (await get(KIVU.lead, `/decisions/${d.id}/work`)).body.work;
    expect(work[0].state).toBe("sync_pending");
    clock += 60_000;
    await api.drainOutbox();
    work = (await get(KIVU.lead, `/decisions/${d.id}/work`)).body.work;
    expect(work[0].state).toBe("linked");
    expect(compass.taskCount(KIVU.ws)).toBe(1);
  });

  it("a stale approval cannot dispatch work after the revision changes", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(KIVU.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    await approve(d.id, e.id, d.revision);
    const alts = [baselineAlternative(ASOF), { ...leadFollowUpAlternative(ASOF), spendMinor: 400_000 }];
    const edit = await call(KIVU.lead, { method: "PATCH", path: ws(KIVU.ws, `/decisions/${d.id}`), body: { alternatives: alts }, ifRevision: d.revision });
    expect(edit.status).toBe(200);
    expect(edit.body.decision.revision).toBe(d.revision + 1);
    expect(edit.body.decision.state).toBe("Draft");
    await api.drainOutbox();
    expect(compass.taskCount(KIVU.ws)).toBe(0);
    const approvals = (await get(KIVU.lead, `/decisions/${d.id}`)).body.approvals;
    expect(approvals.every((a: { active: boolean }) => !a.active)).toBe(true);
    // Approving with the old revision is a stale precondition.
    expect((await approve(d.id, e.id, d.revision, KIVU.exec, "late")).status).toBe(412);
  });

  it("an operator can submit evidence, a reviewer can reject it, and both are audited", async () => {
    const work = (await get(KIVU.operator, "/work")).body.work.find((w: { state: string }) => w.state === "linked");
    expect(work).toBeTruthy();
    const ev = await post(KIVU.operator, `/work/${work.id}/evidence`, { title: "Screenshot", kind: "link", digest: "b".repeat(64), sensitivity: "internal" });
    expect(ev.status).toBe(201);
    const rej = await post(KIVU.finance, `/work/${work.id}/delivery-review`, { verdict: "reject", reason: "Missing the 30 SMB accounts." });
    expect(rej.status).toBe(200);
    expect(rej.body.decision.state).toBe("Executing");
    const audit = (await get(KIVU.auditor, "/audit")).body.events.map((e: { action: string }) => e.action);
    expect(audit).toContain("evidence.submitted");
    expect(audit).toContain("delivery.rejected");
  });

  it("an actor outside the authorized lane cannot approve, dispatch or review", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(KIVU.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    expect((await approve(d.id, e.id, d.revision, KIVU.operator)).status).toBe(403);
    expect((await approve(d.id, e.id, d.revision, KIVU.lead)).status).toBe(403); // no self-approval
    expect((await post(KIVU.operator, "/policy", { maxLossProbability: 0.9 })).status).toBe(403);
    expect((await post(KIVU.auditor, "/decisions", {})).status).toBe(403);
  });

  it("outcomes trace to source rows and the exact metric version; rankings replay from the snapshot", async () => {
    const outcomes = (await get(KIVU.finance, "/outcomes")).body.outcomes;
    const o = outcomes[0];
    expect(o.metricVersion).toBeGreaterThanOrEqual(1);
    expect(o.sourceRowIds.length).toBeGreaterThan(0);
    const replay = await post(KIVU.finance, `/evaluations/${o.evaluationId}/replay`, {});
    expect(replay.status).toBe(200);
    expect(replay.body.matches).toBe(true);
  });

  it("invalid payloads are 400 and unknown routes 404", async () => {
    expect((await post(KIVU.lead, "/decisions", { objectiveId: 5 })).status).toBe(400);
    expect((await get(KIVU.lead, "/nope")).status).toBe(404);
    expect((await get("u-nobody", "/today")).status).toBe(404);
  });

  it("an objective without owner, source, baseline period and target date cannot influence rankings", async () => {
    const r = await post(KIVU.admin, "/objectives", { name: "Gross margin", metricId: KIVU.metric, direction: "increase", targetValue: 1 });
    expect(r.status).toBe(201);
    expect(r.body.objective.status).toBe("draft");
    expect(r.body.objective.missing).toEqual(expect.arrayContaining(["owner", "baselinePeriod", "deadline"]));
    const d = await post(KIVU.lead, "/decisions", { objectiveId: r.body.objective.id, title: "x", hypothesis: "", horizonDays: 90, cohortSize: 1, alternatives: [baselineAlternative(ASOF), leadFollowUpAlternative(ASOF)] });
    expect(d.status).toBe(201);
    const ev = await post(KIVU.lead, `/decisions/${d.body.decision.id}/evaluations`, {});
    expect(ev.status).toBe(403);
    expect(ev.body.error.code).toBe("objective_inactive");
  });

  it("Today shows KPIs with freshness, decisions needing attention, owned work and outcome changes", async () => {
    const t = (await get(KIVU.exec, "/today")).body;
    expect(t.kpis[0]).toEqual(expect.objectContaining({ baseline: expect.any(Object), target: expect.any(Object), freshness: expect.any(Object) }));
    expect(t.kpis[0].series.length).toBeGreaterThan(8);
    expect(Array.isArray(t.attention)).toBe(true);
    expect(t.attention.some((a: { state: string }) => a.state === "AwaitingApproval")).toBe(true);
    expect(Array.isArray(t.work)).toBe(true);
    expect(Array.isArray(t.outcomes)).toBe(true);
    expect(t.calibration).toEqual(expect.objectContaining({ n: expect.any(Number) }));
  });

  it("state survives a save/load round trip", async () => {
    const d = await newDecision();
    const restored = new EnterpriseApi(JSON.parse(JSON.stringify(api.snapshot())), { now, compass });
    expect((await restored.handle(KIVU.lead, { method: "GET", path: ws(KIVU.ws, `/decisions/${d.id}`) })).status).toBe(200);
  });
});
