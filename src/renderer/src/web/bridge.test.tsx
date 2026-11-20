import { describe, expect, it } from "vitest";
import { createWebBridge, WEB_STATE_KEY } from "./bridge";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}
const now = () => "2026-11-20T08:00:00.000Z";

const sample = { companyName: "Example Co", businessModel: "commerce" as const, currency: "EUR", timezone: "UTC", fiscalYearStartMonth: 1, admin: { name: "Ada Admin", title: "Ops" }, sampleData: true };

describe("web bridge (browser edition of the enterprise backend)", () => {
  it("starts with no workspace; creating one signs its admin in", async () => {
    const b = createWebBridge(memoryStorage(), now);
    expect(await b.entSession()).toEqual({ actorId: null, identities: [] });
    await b.entCreateWorkspace(sample);
    const s = await b.entSession();
    expect(s.actorId).toBe(s.identities.find((i) => i.role === "admin")!.id);
    expect((await b.entRequest({ method: "GET", path: `/v1/workspaces/${s.identities[0].workspaceId}/today` })).status).toBe(200);
  });

  it("runs the evaluation worker and outbox, and persists across reloads", async () => {
    const store = memoryStorage();
    const a = createWebBridge(store, now);
    await a.entCreateWorkspace(sample);
    const s = await a.entSession();
    const exec = s.identities.find((i) => i.role === "executive")!;
    const path = (p: string) => `/v1/workspaces/${exec.workspaceId}${p}`;
    await a.entSignIn(exec.id);
    const list = (await a.entRequest({ method: "GET", path: path("/decisions") })).body as { decisions: { id: string; state: string }[] };
    const id = list.decisions.find((d) => d.state === "AwaitingApproval")!.id;
    const d = (await a.entRequest({ method: "GET", path: path(`/decisions/${id}`) })).body as { decision: { revision: number; latestEvaluationId: string } };
    const r = await a.entRequest({ method: "POST", path: path(`/decisions/${id}/approvals`), body: { evaluationId: d.decision.latestEvaluationId, verdict: "approve", reason: "ok" }, ifRevision: d.decision.revision, idempotencyKey: "k" });
    expect(r.status).toBe(201);
    expect(store.raw.has(WEB_STATE_KEY)).toBe(true);

    const reloaded = createWebBridge(store, now);
    expect((await reloaded.entSession()).actorId).toBe(exec.id);
    const after = (await reloaded.entRequest({ method: "GET", path: path(`/decisions/${id}`) })).body as { decision: { state: string }; work: { compassTaskId: string }[] };
    expect(after.decision.state).toBe("Executing");
    expect(after.work[0].compassTaskId).toMatch(/^CMP-/);
  });

  it("refuses unknown identities and resets to onboarding", async () => {
    const store = memoryStorage();
    const b = createWebBridge(store, now);
    await expect(b.entSignIn("u-nobody")).rejects.toThrow();
    await b.entCreateWorkspace(sample);
    await b.entReset();
    expect(await b.entSession()).toEqual({ actorId: null, identities: [] });
  });

  it("starts fresh when stored state is corrupt", async () => {
    const store = memoryStorage();
    store.setItem(WEB_STATE_KEY, "{not json");
    const b = createWebBridge(store, now);
    expect((await b.entSession()).actorId).toBeNull();
  });
});

describe("web edition shell", () => {
  it("says the workspace lives in the browser, and explains the desktop-only Workbench", async () => {
    const { render, screen } = await import("@testing-library/react");
    const userEvent = (await import("@testing-library/user-event")).default;
    const { WebApp } = await import("./WebApp");
    window.archymedes = createWebBridge(memoryStorage(), now) as unknown as typeof window.archymedes;
    const user = userEvent.setup();
    render(<WebApp />);
    expect(await screen.findByText(/run entirely in your browser/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /coding workbench/ }));
    expect(screen.getByRole("dialog", { name: "Workbench" })).toHaveTextContent("desktop-only");
  });
});
