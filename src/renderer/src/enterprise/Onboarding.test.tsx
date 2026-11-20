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

async function onboard(user: ReturnType<typeof userEvent.setup>, opts: { sample: boolean }) {
  render(<EnterpriseApp onOpenWorkbench={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "Set up your workspace" })).toBeInTheDocument();
  await user.type(screen.getByLabelText("Company name"), "Northwind");
  await user.click(screen.getByRole("radio", { name: /Professional services/ }));
  await user.selectOptions(screen.getByLabelText("Currency"), "GBP");
  await user.type(screen.getByLabelText("Your name"), "Jo Bloggs");
  await user.type(screen.getByLabelText("Your title"), "COO");
  await user.click(screen.getByRole("radio", { name: opts.sample ? /sample data/i : /Start empty/i }));
  await user.click(screen.getByRole("button", { name: "Create workspace" }));
}

describe("onboarding — any company", () => {
  it("creates an empty workspace from a template; the goal waits for data", async () => {
    const user = userEvent.setup();
    await onboard(user, { sample: false });
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("Northwind")).toBeInTheDocument();
    expect(screen.getAllByText(/Grow recognized gross profit/).length).toBeGreaterThan(0);
    const blockers = screen.getByRole("region", { name: "Blockers" });
    expect(within(blockers).getByText(/needs a data source, a baseline period, a target/)).toBeInTheDocument();
  });

  it("with sample data, opens on decisions waiting for the admin's team", async () => {
    const user = userEvent.setup();
    await onboard(user, { sample: true });
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Decisions/ }));
    expect(await screen.findByRole("region", { name: "Awaiting approval" })).toBeInTheDocument();
  });

  it("will not create a workspace without a company name", async () => {
    const user = userEvent.setup();
    render(<EnterpriseApp onOpenWorkbench={vi.fn()} />);
    await screen.findByRole("heading", { name: "Set up your workspace" });
    await user.type(screen.getByLabelText("Your name"), "Jo");
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeDisabled();
  });
});
