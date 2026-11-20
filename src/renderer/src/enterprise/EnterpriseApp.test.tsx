import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntRequest } from "@shared/enterprise/api-types";
import { EnterpriseApi } from "../../../main/enterprise/api";
import { LocalCompassAdapter } from "../../../main/enterprise/compass-adapter";
import { KIVU, seedState } from "../../../main/enterprise/seed";
import { createFakeApi } from "../../test/fake-api";
import { EnterpriseApp } from "./EnterpriseApp";

const now = () => "2026-11-20T08:00:00.000Z";
let api: EnterpriseApi;
let actor: string | null;

beforeEach(() => {
  api = new EnterpriseApi(seedState(now()), { now, compass: new LocalCompassAdapter([], now) });
  actor = null;
  window.archymedes = createFakeApi({
    entSession: vi.fn(async () => ({
      actorId: actor,
      identities: api.snapshot().members.map((m) => ({ id: m.id, name: m.name, title: m.title, role: m.role, workspaceId: m.tenantId === KIVU.tenant ? KIVU.ws : "ws-lake", tenantName: m.tenantId })),
    })),
    entSignIn: vi.fn(async (id: string) => {
      actor = id;
    }),
    entRequest: vi.fn(async (req: EntRequest) => {
      if (!actor) return { status: 401, body: { error: { code: "signed_out", message: "" } } };
      const res = await api.handle(actor, req);
      if (req.method !== "GET") {
        await api.runJobs();
        await api.drainOutbox();
      }
      return res;
    }),
  });
});

describe("Archymedes Desktop — enterprise OS", () => {
  it("signs in, reads Today, and approves a decision through to linked Compass work", async () => {
    const user = userEvent.setup();
    render(<EnterpriseApp onOpenWorkbench={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Eric Mugisha/ }));

    // Today: KPI and the decision awaiting this executive.
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    const attention = await screen.findByRole("region", { name: "Decisions needing attention" });
    expect(within(attention).getByText("Lift trial-to-paid conversion")).toBeInTheDocument();

    // Open the decision: Orion comparison with the §6 numbers.
    await user.click(within(attention).getByRole("button", { name: /Lift trial-to-paid conversion/ }));
    const panel = await screen.findByRole("dialog", { name: /Lift trial-to-paid conversion/ });
    expect(within(panel).getAllByText("$4,500").length).toBeGreaterThan(0); // EV contribution
    expect(within(panel).getAllByText("75%").length).toBeGreaterThan(0); // P(goal)

    // Approve with a reason, behind a confirmation step.
    await user.click(within(panel).getByRole("button", { name: "Approve" }));
    await user.type(within(panel).getByLabelText("Reason"), "Within risk appetite.");
    await user.click(within(panel).getByRole("button", { name: "Confirm approval" }));

    await waitFor(() => expect(within(panel).getByTestId("lifecycle-current")).toHaveTextContent("Executing"));
    expect((await within(panel).findAllByText(/CMP-\d+/)).length).toBeGreaterThan(0);
  });

  it("an operator cannot see approve controls", async () => {
    const user = userEvent.setup();
    render(<EnterpriseApp onOpenWorkbench={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Jean Habimana/ }));
    await user.click(await screen.findByRole("button", { name: /Decisions/ }));
    await user.click(await screen.findByRole("button", { name: /Lift trial-to-paid conversion/ }));
    const panel = await screen.findByRole("dialog", { name: /Lift trial-to-paid conversion/ });
    expect(within(panel).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});
