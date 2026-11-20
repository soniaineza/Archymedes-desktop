import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionSummary, EntResponse } from "../../shared/enterprise/api-types";
import type { WorkspaceInput } from "../../shared/enterprise/templates";
import { INVOKE_GUARDS } from "../../shared/ipc-guards";
import { EnterpriseService } from "./service";

let dir: string;
const now = () => "2026-11-20T08:00:00.000Z";
const sample: WorkspaceInput = { companyName: "Example Co", businessModel: "subscription", currency: "USD", timezone: "UTC", fiscalYearStartMonth: 1, admin: { name: "Ada Admin", title: "Ops" }, sampleData: true };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ent-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function ready(s: EnterpriseService) {
  await s.createWorkspace(sample);
  const sess = await s.session();
  const id = (role: string) => sess.identities.find((i) => i.role === role)!.id;
  const ws = sess.identities[0].workspaceId;
  const call = (method: "GET" | "POST", p: string, body?: unknown, extra: object = {}) => s.request({ method, path: `/v1/workspaces/${ws}${p}`, body, ...extra }) as Promise<EntResponse<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { id, call };
}

describe("EnterpriseService (desktop file store)", () => {
  it("starts empty, creates a workspace, and persists across restarts", async () => {
    const a = new EnterpriseService(dir, { now });
    expect((await a.session()).identities).toEqual([]);
    const { id, call } = await ready(a);
    expect((await call("POST", "/policy", { maxLossProbability: 0.5 })).status).toBe(201); // signed in as admin
    await a.signIn(id("lead"));
    expect((await call("POST", "/policy", { maxLossProbability: 0.4 })).status).toBe(403);
    await a.flush();

    const b = new EnterpriseService(dir, { now });
    expect((await b.session()).actorId).toBe(id("lead"));
    const ws = (await b.session()).identities[0].workspaceId;
    const policy = await b.request({ method: "GET", path: `/v1/workspaces/${ws}/policy` });
    expect((policy.body as { policy: { version: number } }).policy.version).toBe(2);
  });

  it("refuses to sign in as an unknown identity", async () => {
    const s = new EnterpriseService(dir, { now });
    await expect(s.signIn("u-nobody")).rejects.toThrow();
  });

  it("runs the evaluation worker and outbox after each mutation", async () => {
    const s = new EnterpriseService(dir, { now });
    const { id, call } = await ready(s);
    await s.signIn(id("executive"));
    const awaiting = ((await call("GET", "/decisions")).body.decisions as DecisionSummary[]).find((d) => d.state === "AwaitingApproval")!;
    const detail = (await call("GET", `/decisions/${awaiting.id}`)).body;
    const r = await call("POST", `/decisions/${awaiting.id}/approvals`, { evaluationId: detail.decision.latestEvaluationId, verdict: "approve", reason: "ok" }, { ifRevision: detail.decision.revision, idempotencyKey: "x" });
    expect(r.status).toBe(201);
    expect((await call("GET", `/decisions/${awaiting.id}`)).body.decision.state).toBe("Executing");
  });

  it("resetAll returns to onboarding", async () => {
    const s = new EnterpriseService(dir, { now });
    await ready(s);
    await s.resetAll();
    expect(await s.session()).toEqual({ actorId: null, identities: [] });
  });
});

describe("enterprise IPC guards", () => {
  it("accept a well-formed request and strip unknown fields", () => {
    const [req] = INVOKE_GUARDS["ent:request"]([{ method: "GET", path: "/v1/workspaces/ws-x/today", extra: 1 }]);
    expect(req).toEqual({ method: "GET", path: "/v1/workspaces/ws-x/today" });
  });
  it("reject bad methods, paths and revision types", () => {
    expect(() => INVOKE_GUARDS["ent:request"]([{ method: "DELETE", path: "/v1/workspaces/x/today" }])).toThrow();
    expect(() => INVOKE_GUARDS["ent:request"]([{ method: "GET", path: "/etc/passwd" }])).toThrow();
    expect(() => INVOKE_GUARDS["ent:request"]([{ method: "POST", path: "/v1/workspaces/x/a", ifRevision: "1" }])).toThrow();
    expect(() => INVOKE_GUARDS["ent:sign-in"](["../x"])).toThrow();
  });
  it("validate new-workspace input", () => {
    expect(INVOKE_GUARDS["ent:create-workspace"]([{ ...sample, extra: 1 }])).toEqual([sample]);
    expect(() => INVOKE_GUARDS["ent:create-workspace"]([{ ...sample, currency: "dollars" }])).toThrow();
    expect(() => INVOKE_GUARDS["ent:create-workspace"]([{ ...sample, admin: { name: "" } }])).toThrow();
  });
});
