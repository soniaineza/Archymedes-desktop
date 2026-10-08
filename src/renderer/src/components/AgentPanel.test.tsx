import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@shared/types";
import type { ProviderId } from "@shared/providers";
import { getPrefs, reloadPrefs } from "../lib/prefs";
import { fakeApi } from "../../test/fake-api";
import { renderWithProviders } from "../../test/render";
import { useAgent } from "../lib/useAgent";
import { AgentPanel } from "./AgentPanel";

function Harness(props: { hasKey?: boolean; onOpenDiff?: (path: string) => void; onOpenSettings?: () => void; provider?: ProviderId }) {
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
      provider={props.provider ?? "anthropic"}
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
  it("shows a pending shell command and sends the user's decision", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    emit(
      { type: "status", status: "awaiting-approval" },
      { type: "approval-request", requestId: "approval-1", toolCallId: "call-1", command: "rm build && npm run release" },
    );

    const card = screen.getByRole("alertdialog", { name: "Run this command?" });
    expect(card).toHaveTextContent("rm build && npm run release");

    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(fakeApi().approveCommand).toHaveBeenCalledWith("approval-1", "deny");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("shows the tokens each reply used under it", () => {
    renderWithProviders(<Harness />);

    emit(
      { type: "message-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "Here you go" },
      { type: "message-end", id: "m1", usage: { inputTokens: 1_200, outputTokens: 340 } },
      { type: "status", status: "idle" },
    );

    expect(screen.getByText("↑1.2K ↓340 tokens")).toBeInTheDocument();
  });
  describe("free mode", () => {
    it("shows a one-time privacy notice until it is dismissed", async () => {
      reloadPrefs();
      const user = userEvent.setup();
      const { unmount } = renderWithProviders(<Harness provider="free" />);
      const notice = "Free models may log your prompts and code. Don't share secrets; use a paid provider for private code.";
      expect(screen.getByText(notice)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText(notice)).not.toBeInTheDocument();
      expect(getPrefs().freePrivacyNoticeDismissed).toBe(true);
      unmount();
      renderWithProviders(<Harness provider="free" />);
      expect(screen.queryByText(notice)).not.toBeInTheDocument();
    });

    it("never shows the notice for other providers", () => {
      reloadPrefs();
      renderWithProviders(<Harness provider="anthropic" />);
      expect(screen.queryByText(/Free models may log/)).not.toBeInTheDocument();
    });

    it("explains a data-policy refusal and opens OpenRouter's privacy settings", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Harness provider="free" />);
      emit({ type: "error", message: "No endpoints found matching your data policy", code: "free-data-policy" });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Free models need the free-endpoint options enabled at openrouter.ai/settings/privacy.");
      await user.click(screen.getByRole("button", { name: "Open privacy settings" }));
      expect(fakeApi().openExternal).toHaveBeenCalledWith("https://openrouter.ai/settings/privacy");
    });

    it("tells a per-minute limit from a used-up day", async () => {
      renderWithProviders(<Harness provider="free" />);
      emit({ type: "error", message: "x", code: "free-rate-minute", params: { seconds: 42 } });
      expect(await screen.findByRole("alert")).toHaveTextContent("Wait about 42 seconds, then send again.");
      emit({ type: "error", message: "x", code: "free-daily-limit", params: { time: "00:00" } });
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Today's free allowance is used up. It resets at 00:00 UTC."));
    });
  });
});
