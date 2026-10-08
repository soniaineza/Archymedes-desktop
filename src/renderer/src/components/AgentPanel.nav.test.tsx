import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeApi } from "../../test/fake-api";
import { renderWithProviders } from "../../test/render";
import { reloadPrefs, setPref } from "../lib/prefs";
import { useAgent } from "../lib/useAgent";
import { AgentPanel } from "./AgentPanel";
import type { ChatRequest } from "./AgentPanel";

beforeEach(() => reloadPrefs());

function Harness({ request }: { request?: ChatRequest | null }) {
  const agent = useAgent();
  return (
    <AgentPanel
      agent={agent}
      modelLabel="Test model"
      hasKey
      files={[]}
      onOpenFile={vi.fn()}
      onOpenDiff={vi.fn()}
      onOpenSettings={vi.fn()}
      request={request}
    />
  );
}

const composer = () => screen.getByRole("textbox", { name: /Ask anything/ });

describe("AgentPanel navigation", () => {
  it("focuses the message box on a focus request", () => {
    renderWithProviders(<Harness request={{ kind: "focus", id: 1 }} />);
    expect(composer()).toHaveFocus();
  });

  it("opens the past-chats list on a history request and from the History button", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(<Harness />);
    expect(screen.queryByRole("dialog", { name: "Chat sessions" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Past chats" }));
    expect(screen.getByRole("dialog", { name: "Chat sessions" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Chat sessions" })).toBeNull();

    rerender(<Harness request={{ kind: "history", id: 2 }} />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Chat sessions" })).toBeInTheDocument());
    expect(fakeApi().listSessions).toHaveBeenCalled();
  });

  it("sends with Ctrl+Enter and keeps Enter for new lines when configured", async () => {
    setPref("chatSendKey", "ctrlEnter");
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.type(composer(), "a{Enter}b");
    expect(fakeApi().sendAgentMessage).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("a\nb");

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(fakeApi().sendAgentMessage).toHaveBeenCalledOnce();
  }, 15_000);
});
