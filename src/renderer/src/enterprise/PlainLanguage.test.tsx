import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchymedesApi } from "@shared/types";
import { createWebBridge } from "../web/bridge";
import { EnterpriseApp } from "./EnterpriseApp";

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

beforeEach(() => {
  window.archymedes = createWebBridge(memoryStorage(), () => "2026-11-20T08:00:00.000Z") as unknown as ArchymedesApi;
});

describe("anyone can understand what it is", () => {
  it("the first screen explains the loop in five plain steps", async () => {
    render(<EnterpriseApp onOpenWorkbench={vi.fn()} />);
    const how = await screen.findByRole("region", { name: "How it works" });
    for (const step of ["Set a goal", "Compare options", "Approve one", "Do the work", "Measure the result"]) expect(within(how).getByText(step)).toBeInTheDocument();
  });

  it("inside the app, decisions use plain words and a guide explains the terms", async () => {
    const user = userEvent.setup();
    await window.archymedes.entCreateWorkspace({ companyName: "Any Co", businessModel: "subscription", currency: "USD", timezone: "UTC", fiscalYearStartMonth: 1, admin: { name: "Pat", title: "" }, sampleData: true });
    render(<EnterpriseApp onOpenWorkbench={vi.fn()} />);
    await screen.findByRole("heading", { name: "Today" });

    await user.click(screen.getByRole("button", { name: "How it works" }));
    const guide = await screen.findByRole("dialog", { name: "How it works" });
    for (const term of ["Expected profit gain", "Chance of hitting the goal", "Chance of losing money", "Lasting advantage", "Orion", "Compass"]) expect(within(guide).getAllByText(new RegExp(term)).length).toBeGreaterThan(0);
    await user.click(within(guide).getByRole("button", { name: /Close/ }));

    await user.click(screen.getByRole("button", { name: /Decisions/ }));
    const col = await screen.findByRole("region", { name: "Awaiting approval" });
    await user.click(within(col).getAllByRole("button")[0]);
    const panel = await screen.findByRole("dialog", { name: /compare|or/i });
    expect(within(panel).getAllByText("Expected profit gain").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("Chance of hitting the goal").length).toBeGreaterThan(0);
    expect(within(panel).queryByText(/E\[contribution\]|P\(goal\)|P\(loss\)/)).not.toBeInTheDocument();
  }, 15_000);
});
