import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi } from "../../test/fake-api";
import { renderWithProviders } from "../../test/render";
import { SessionSwitcher } from "./SessionSwitcher";

function renderSwitcher(onRefresh = vi.fn()) {
  renderWithProviders(
    <SessionSwitcher
      sessions={[]}
      currentId="s1"
      currentTitle="Chat"
      dirtyFlag={0}
      onSwitch={vi.fn()}
      onNew={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onRefresh={onRefresh}
      open
    />,
  );
  return { onRefresh };
}

describe("SessionSwitcher legacy chats", () => {
  it("offers to move older unlinked chats into the open project", async () => {
    const user = userEvent.setup();
    vi.mocked(fakeApi().listLegacySessions).mockResolvedValueOnce({
      count: 3,
      ids: ["a", "b", "c"],
    });
    const { onRefresh } = renderSwitcher();
    expect(
      await screen.findByText("3 older chats aren't linked to a project."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Move them here" }));
    expect(fakeApi().adoptLegacySessions).toHaveBeenCalledWith("all");
    await waitFor(() => expect(screen.queryByText(/older chats/)).not.toBeInTheDocument());
    expect(onRefresh).toHaveBeenCalled();
  });

  it("shows nothing when every chat belongs to a project", async () => {
    renderSwitcher();
    await waitFor(() => expect(fakeApi().listLegacySessions).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Move them here" })).not.toBeInTheDocument();
  });
});
