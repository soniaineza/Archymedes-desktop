import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluator";
import { BUSINESS_TEMPLATES, buildWorkspace, exampleAlternatives, objectiveReadiness, validateWorkspaceInput } from "./templates";
import type { WorkspaceInput } from "./templates";

const NOW = "2026-11-20T08:00:00.000Z";
let n = 0;
const ids = (p: string) => `${p}-${++n}`;
const input = (over: Partial<WorkspaceInput> = {}): WorkspaceInput => ({
  companyName: "Acme",
  businessModel: "subscription",
  currency: "EUR",
  timezone: "Europe/Lisbon",
  fiscalYearStartMonth: 4,
  admin: { name: "Sam Rivera", title: "Operations lead" },
  sampleData: false,
  ...over,
});

describe("business templates (spec §4)", () => {
  it("cover the three business models with an objective, leading signals and guardrails", () => {
    expect(BUSINESS_TEMPLATES.map((t) => t.model).sort()).toEqual(["commerce", "services", "subscription"]);
    for (const t of BUSINESS_TEMPLATES) {
      expect(t.objectiveName).toBeTruthy();
      expect(t.leadingIndicators.length).toBeGreaterThan(1);
      expect(t.guardrails.length).toBeGreaterThan(1);
      expect(t.metrics.length).toBeGreaterThan(0);
      expect(t.examples.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("every template's example interventions evaluate completely against a no-change baseline", () => {
    for (const t of BUSINESS_TEMPLATES) {
      const alts = exampleAlternatives(t, NOW);
      expect(alts.filter((a) => a.isBaseline)).toHaveLength(1);
      const r = evaluate({
        decisionId: "d",
        decisionRevision: 1,
        objectiveLabel: t.objectiveName,
        currency: "EUR",
        horizonDays: 90,
        asOf: NOW,
        grossMarginBps: t.grossMarginBps,
        cohortSize: 100,
        goal: { basis: "incremental_revenue", direction: "increase", target: t.interventionTargetMajor * 100, label: "" },
        policy: { maxLossProbability: 0.3, maxSpendMinor: 10_000_000, maxDownsideExposureMinor: 10_000_000, maxInputAgeDays: 45 },
        alternatives: alts,
      });
      expect(r.status).toBe("complete");
    }
  });
});

describe("buildWorkspace", () => {
  it("creates a company-specific tenant with only its admin, in the chosen currency and calendar", () => {
    const w = buildWorkspace(input(), NOW, ids);
    expect(w.tenant.name).toBe("Acme");
    expect(w.members).toEqual([expect.objectContaining({ name: "Sam Rivera", role: "admin", tenantId: w.tenant.id })]);
    expect(w.profile).toEqual(expect.objectContaining({ currency: "EUR", timezone: "Europe/Lisbon", fiscalYearStartMonth: 4, businessModel: "subscription", version: 1 }));
    expect(w.policy.version).toBe(1);
    expect(w.rows).toEqual([]);
    expect(w.decisions).toEqual([]);
  });

  it("starts the template goal as a draft that names what it still needs", () => {
    const w = buildWorkspace(input({ businessModel: "commerce" }), NOW, ids);
    const o = w.objectives[0];
    const t = BUSINESS_TEMPLATES.find((x) => x.model === "commerce")!;
    expect(o.name).toBe(t.objectiveName);
    expect(o.ownerId).toBe(w.members[0].id);
    expect(o.guardrails).toEqual(t.guardrails);
    expect(objectiveReadiness(o, w.metrics.find((m) => m.id === o.metricId)!, 0)).toEqual(expect.arrayContaining(["source", "baselinePeriod", "target"]));
  });

  it("with sample data, adds a team, history and decisions in several states", () => {
    const w = buildWorkspace(input({ sampleData: true, businessModel: "services", currency: "JPY" }), NOW, ids);
    expect(w.members.length).toBeGreaterThan(4);
    expect(new Set(w.members.map((m) => m.role))).toEqual(new Set(["admin", "executive", "lead", "operator", "finance", "auditor"]));
    expect(w.rows.length).toBeGreaterThan(100);
    expect(w.rows.every((r) => r.currency === "JPY" && Number.isSafeInteger(r.amountMinor))).toBe(true);
    const states = new Set(w.decisions.map((d) => d.state));
    for (const s of ["AwaitingApproval", "Executing", "Measuring", "Debriefed"]) expect(states.has(s as never)).toBe(true);
    const o = w.objectives[0];
    expect(objectiveReadiness(o, w.metrics.find((m) => m.id === o.metricId)!, w.rows.length)).toEqual([]);
    expect(w.outcomes.length).toBeGreaterThan(0);
    expect(w.forecasts.length).toBeGreaterThan(3);
  });

  it("names nothing after a real company or place", () => {
    const text = JSON.stringify(buildWorkspace(input({ sampleData: true }), NOW, ids));
    expect(text).not.toMatch(/Kivu|Kigali|Rwanda|Lakeside/);
  });
});

describe("validateWorkspaceInput", () => {
  it("accepts a well-formed input and rejects bad currency, model, month or names", () => {
    expect(validateWorkspaceInput(input())).toEqual([]);
    expect(validateWorkspaceInput(input({ currency: "euro" }))).toContain("currency");
    expect(validateWorkspaceInput(input({ businessModel: "bank" as never }))).toContain("businessModel");
    expect(validateWorkspaceInput(input({ fiscalYearStartMonth: 13 }))).toContain("fiscalYearStartMonth");
    expect(validateWorkspaceInput(input({ companyName: " " }))).toContain("companyName");
    expect(validateWorkspaceInput(input({ admin: { name: "", title: "" } }))).toContain("admin.name");
    expect(validateWorkspaceInput(input({ timezone: "Mars/Olympus" }))).toContain("timezone");
  });
});
