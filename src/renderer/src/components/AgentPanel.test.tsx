import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@shared/types";
import { fakeApi } from "../../test/fake-api";
import { renderWithProviders } from "../../test/render";
import { useAgent } from "../lib/useAgent";
import { AgentPanel } from "./AgentPanel";

function Harness(props: { hasKey?: boolean; onOpenDiff?: (path: string) => void; onOpenSettings?: () => void }) {
  const agent = useAgent();
  return (
    <AgentPanel
      agent={agent}
      modelLabel="Anthropic · claude-sonnet-5"
      hasKey={props.hasKey ?? true}
      files={["src/main.ts", "src/app/App.tsx", "README.md"]}
      onOpenFile={vi.fn()}
      onOpenDiff={props.onOpenDiff ?? vi.fn()}
      onOpenSettings={props.onOpenSettings ?? vi.fn()}
    />
  );
}

/** Delivers events one at a time, the way separate IPC messages reach the renderer. */
function emit(...events: AgentEvent[]) {
  for (const event of events) {
    act(() => fakeApi().emitAgentEvent(event));
  }
}

const composer = () => screen.getByRole("textbox", { name: /Ask anything/ });

describe("AgentPanel", () => {
  it("offers suggestions that fill the composer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole("button", { name: "Explain what this project does" }));

    expect(composer()).toHaveValue("Explain what this project does");
  });

  it("sends on Enter and shows the message", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.type(composer(), "fix the bug{Enter}");

    expect(fakeApi().sendAgentMessage).toHaveBeenCalledOnce();
    expect(screen.getByText("fix the bug", { selector: ".bubble" })).toBeInTheDocument();
    // The first message also names the chat (accessible name is the title text).
    expect(screen.getByRole("button", { name: "fix the bug" })).toBeInTheDocument();
    expect(composer()).toHaveValue("");
  });

  it("renders a streamed reply and its tool call, with a diff link once the edit lands", async () => {
    const user = userEvent.setup();
    const onOpenDiff = vi.fn();
    renderWithProviders(<Harness onOpenDiff={onOpenDiff} />);

    emit(
      { type: "status", status: "calling-tool" },
      { type: "message-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "Updating " },
      { type: "text-delta", id: "m1", delta: "the **entry point**." },
      { type: "tool-start", id: "m1", toolCallId: "t1", name: "write_file", args: '{"path":"src/main.ts","content":"x"}' },
    );

    expect(screen.getByText("entry point")).toContainHTML("strong");
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("src/main.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Diff/ })).not.toBeInTheDocument();

    emit({ type: "tool-result", toolCallId: "t1", result: "Wrote src/main.ts (1 bytes).", isError: false });
    await user.click(screen.getByRole("button", { name: /Diff/ }));

    expect(onOpenDiff).toHaveBeenCalledWith("src/main.ts");
  });

  it("shows a translated error with a way to fix it", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderWithProviders(<Harness onOpenSettings={onOpenSettings} />);
    vi.mocked(fakeApi().sendAgentMessage).mockRejectedValueOnce(
      new Error(`Error invoking remote method 'agent:send': Error: ARCHYMEDES_APP_ERROR:{"code":"no-api-key","message":"x"}`),
    );

    await user.type(composer(), "hello{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No API key configured. Open Settings and add the key for your provider.");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("lists commands for /help without contacting the agent", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.type(composer(), "/help{Enter}");

    expect(screen.getByText("/sessions")).toBeInTheDocument();
    expect(fakeApi().sendAgentMessage).not.toHaveBeenCalled();
  });

  it("completes @mentions from workspace files", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.type(composer(), "look at @app");
    expect(screen.getByRole("option", { name: /src\/app\/App\.tsx/ })).toBeInTheDocument();
    await user.keyboard("{Tab}");

    await waitFor(() => expect(composer()).toHaveValue("look at @src/app/App.tsx "));
  });
});
