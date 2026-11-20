import { describe, expect, it } from "vitest";
import type { WorkspaceInput } from "../../shared/enterprise/templates";
import { EnterpriseHost } from "./host";
import type { Persisted } from "./host";

const now = () => "2026-11-20T08:00:00.000Z";
function memoryStore() {
  let data: Persisted | null = null;
  return { load: async () => data, save: async (d: Persisted) => void (data = structuredClone(d)) };
}
const input: WorkspaceInput = { companyName: "Northwind", businessModel: "services", currency: "GBP", timezone: "Europe/London", fiscalYearStartMonth: 4, admin: { name: "Jo Bloggs", title: "COO" }, sampleData: false };

describe("EnterpriseHost — company-agnostic start", () => {
  it("starts with no workspace and no identities", async () => {
    const h = new EnterpriseHost(memoryStore(), { now });
    expect(await h.session()).toEqual({ actorId: null, identities: [] });
  });

  it("creating a workspace signs its admin in and persists it", async () => {
    const store = memoryStore();
    const h = new EnterpriseHost(store, { now });
    await h.createWorkspace(input);
    const s = await h.session();
    expect(s.identities).toEqual([expect.objectContaining({ name: "Jo Bloggs", role: "admin", tenantName: "Northwind" })]);
    expect(s.actorId).toBe(s.identities[0].id);
    const me = await h.request({ method: "GET", path: `/v1/workspaces/${s.identities[0].workspaceId}/me` });
    expect((me.body as { profile: { currency: string } }).profile.currency).toBe("GBP");

    const again = new EnterpriseHost(store, { now });
    expect((await again.session()).actorId).toBe(s.actorId);
  });

  it("an empty workspace shows no series, actual or forecast until data arrives", async () => {
    const h = new EnterpriseHost(memoryStore(), { now });
    await h.createWorkspace(input);
    const ws = (await h.session()).identities[0].workspaceId;
    const today = (await h.request({ method: "GET", path: `/v1/workspaces/${ws}/today` })).body as { kpis: { series: unknown[]; actual: number | null; forecast: unknown }[] };
    expect(today.kpis[0]).toEqual(expect.objectContaining({ series: [], actual: null, forecast: null }));
  });

  it("rejects an invalid workspace and keeps several workspaces apart", async () => {
    const h = new EnterpriseHost(memoryStore(), { now });
    await expect(h.createWorkspace({ ...input, currency: "pounds" })).rejects.toThrow(/currency/);
    await h.createWorkspace(input);
    await h.createWorkspace({ ...input, companyName: "Contoso", admin: { name: "Lee", title: "CEO" } });
    const s = await h.session();
    expect(new Set(s.identities.map((i) => i.workspaceId)).size).toBe(2);
    const other = s.identities.find((i) => i.tenantName === "Northwind")!;
    const r = await h.request({ method: "GET", path: `/v1/workspaces/${other.workspaceId}/today` });
    expect(r.status).toBe(404); // signed in as Contoso's admin
  });

  it("reset clears everything back to onboarding", async () => {
    const h = new EnterpriseHost(memoryStore(), { now });
    await h.createWorkspace({ ...input, sampleData: true });
    await h.resetAll();
    expect(await h.session()).toEqual({ actorId: null, identities: [] });
  });
});
