import { describe, expect, it } from "vitest";
import { KIVU } from "../../../main/enterprise/seed";
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
const path = (p: string) => `/v1/workspaces/${KIVU.ws}${p}`;

describe("web bridge (browser edition of the enterprise backend)", () => {
  it("requires sign-in, then serves the API as the signed-in identity", async () => {
    const b = createWebBridge(memoryStorage(), now);
    expect((await b.entRequest({ method: "GET", path: path("/today") })).status).toBe(401);
    expect((await b.entSession()).identities.length).toBeGreaterThan(4);
    await b.entSignIn(KIVU.exec);
    expect((await b.entRequest({ method: "GET", path: path("/today") })).status).toBe(200);
  });

  it("runs the evaluation worker and outbox, and persists across reloads", async () => {
    const store = memoryStorage();
    const a = createWebBridge(store, now);
    await a.entSignIn(KIVU.exec);
    const d = (await a.entRequest({ method: "GET", path: path("/decisions/dec-lead-follow-up") })).body as { decision: { revision: number; latestEvaluationId: string } };
    const r = await a.entRequest({ method: "POST", path: path("/decisions/dec-lead-follow-up/approvals"), body: { evaluationId: d.decision.latestEvaluationId, verdict: "approve", reason: "ok" }, ifRevision: d.decision.revision, idempotencyKey: "k" });
    expect(r.status).toBe(201);
    expect(store.raw.has(WEB_STATE_KEY)).toBe(true);

    const reloaded = createWebBridge(store, now);
    expect((await reloaded.entSession()).actorId).toBe(KIVU.exec);
    const after = (await reloaded.entRequest({ method: "GET", path: path("/decisions/dec-lead-follow-up") })).body as { decision: { state: string }; work: { compassTaskId: string }[] };
    expect(after.decision.state).toBe("Executing");
    expect(after.work[0].compassTaskId).toMatch(/^CMP-/);
  });

  it("refuses unknown identities and resets to the seed", async () => {
    const store = memoryStorage();
    const b = createWebBridge(store, now);
    await expect(b.entSignIn("u-nobody")).rejects.toThrow();
    await b.entSignIn(KIVU.admin);
    await b.entRequest({ method: "POST", path: path("/policy"), body: { maxLossProbability: 0.5 } });
    await b.entResetDemo();
    const p = (await b.entRequest({ method: "GET", path: path("/policy") })).body as { policy: { version: number } };
    expect(p.policy.version).toBe(1);
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
    expect(await screen.findByText(/runs entirely in your browser/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /coding workbench/ }));
    expect(screen.getByRole("dialog", { name: "Workbench" })).toHaveTextContent("desktop-only");
  });
});
