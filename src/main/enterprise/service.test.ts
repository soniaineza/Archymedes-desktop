import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INVOKE_GUARDS } from "../../shared/ipc-guards";
import { KIVU } from "./seed";
import { EnterpriseService } from "./service";

let dir: string;
const now = () => "2026-11-20T08:00:00.000Z";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ent-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("EnterpriseService", () => {
  it("seeds on first run, requires a signed-in identity, and persists across restarts", async () => {
    const a = new EnterpriseService(dir, { now });
    await a.ready();
    const anon = await a.request({ method: "GET", path: `/v1/workspaces/${KIVU.ws}/today` });
    expect(anon.status).toBe(401);
    expect((await a.session()).identities.length).toBeGreaterThan(4);
    await a.signIn(KIVU.lead);
    const created = await a.request({ method: "POST", path: `/v1/workspaces/${KIVU.ws}/policy`, body: { maxLossProbability: 0.5 } });
    expect(created.status).toBe(403); // a lead cannot configure policy
    await a.signIn(KIVU.admin);
    expect((await a.request({ method: "POST", path: `/v1/workspaces/${KIVU.ws}/policy`, body: { maxLossProbability: 0.5 } })).status).toBe(201);
    await a.flush();

    const b = new EnterpriseService(dir, { now });
    await b.ready();
    expect((await b.session()).actorId).toBe(KIVU.admin);
    const policy = await b.request({ method: "GET", path: `/v1/workspaces/${KIVU.ws}/policy` });
    expect((policy.body as { policy: { version: number } }).policy.version).toBe(2);
  });

  it("refuses to sign in as an unknown identity", async () => {
    const s = new EnterpriseService(dir, { now });
    await s.ready();
    await expect(s.signIn("u-nobody")).rejects.toThrow();
  });

  it("runs evaluation jobs and drains the outbox after each mutation", async () => {
    const s = new EnterpriseService(dir, { now });
    await s.ready();
    await s.signIn(KIVU.exec);
    const d = await s.request({ method: "GET", path: `/v1/workspaces/${KIVU.ws}/decisions/dec-lead-follow-up` });
    const detail = d.body as { decision: { revision: number; latestEvaluationId: string } };
    const r = await s.request({ method: "POST", path: `/v1/workspaces/${KIVU.ws}/decisions/dec-lead-follow-up/approvals`, body: { evaluationId: detail.decision.latestEvaluationId, verdict: "approve", reason: "ok" }, ifRevision: detail.decision.revision, idempotencyKey: "x" });
    expect(r.status).toBe(201);
    const after = await s.request({ method: "GET", path: `/v1/workspaces/${KIVU.ws}/decisions/dec-lead-follow-up` });
    expect((after.body as { decision: { state: string } }).decision.state).toBe("Executing");
  });

  it("resetDemo restores the seed", async () => {
    const s = new EnterpriseService(dir, { now });
    await s.ready();
    await s.signIn(KIVU.admin);
    await s.request({ method: "POST", path: `/v1/workspaces/${KIVU.ws}/policy`, body: { maxLossProbability: 0.5 } });
    await s.resetDemo();
    const p = await s.request({ method: "GET", path: `/v1/workspaces/${KIVU.ws}/policy` });
    expect((p.body as { policy: { version: number } }).policy.version).toBe(1);
  });
});

describe("enterprise IPC guards", () => {
  it("accept a well-formed request and strip unknown fields", () => {
    const [req] = INVOKE_GUARDS["ent:request"]([{ method: "GET", path: "/v1/workspaces/ws-kivu/today", extra: 1 }]);
    expect(req).toEqual({ method: "GET", path: "/v1/workspaces/ws-kivu/today" });
  });
  it("reject bad methods, paths and revision types", () => {
    expect(() => INVOKE_GUARDS["ent:request"]([{ method: "DELETE", path: "/v1/workspaces/x/today" }])).toThrow();
    expect(() => INVOKE_GUARDS["ent:request"]([{ method: "GET", path: "/etc/passwd" }])).toThrow();
    expect(() => INVOKE_GUARDS["ent:request"]([{ method: "POST", path: "/v1/workspaces/x/a", ifRevision: "1" }])).toThrow();
    expect(() => INVOKE_GUARDS["ent:sign-in"](["../x"])).toThrow();
  });
});
