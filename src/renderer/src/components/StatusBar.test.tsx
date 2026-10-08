import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DailyUsage } from "@shared/types";
import { fakeApi } from "../../test/fake-api";
import { renderWithProviders } from "../../test/render";
import { StatusBar } from "./StatusBar";

const bar = () => (
  <StatusBar status="idle" usage={null} git={{ isRepo: false, branch: "", dirtyCount: 0 }} workspaceName="demo" onOpenPalette={vi.fn()} />
);

describe("StatusBar token meter", () => {
  it("shows today's tokens and the free allowance left, warning past the gateway's threshold", async () => {
    const usage: DailyUsage = {
      date: "2026-10-08",
      tokens: 12_345,
      provider: "free",
      allowance: { remainingTokens: 20_000, resetUtc: "2026-10-09T00:00:00.000Z", warning: "You've used 80% of today's free allowance." },
    };
    vi.mocked(fakeApi().getDailyUsage).mockResolvedValue(usage);
    renderWithProviders(bar());

    expect(await screen.findByText("Today: 12.3K tokens")).toBeInTheDocument();
    const left = screen.getByText("20K left · resets 00:00 UTC");
    expect(left.closest(".seg")).toHaveClass("allowance-warn");

    // Each model request pushes the new count.
    act(() => fakeApi().emitAgentEvent({ type: "daily-usage", usage: { ...usage, tokens: 15_000, allowance: { remainingTokens: 0 } } }));
    expect(screen.getByText("Today: 15K tokens")).toBeInTheDocument();
    expect(screen.getByText("0 left · resets 00:00 UTC").closest(".seg")).toHaveClass("allowance-out");
  });

  it("shows no daily figures for other providers", async () => {
    vi.mocked(fakeApi().getDailyUsage).mockResolvedValue({ date: "2026-10-08", tokens: 500, provider: "anthropic" });
    renderWithProviders(bar());
    await waitFor(() => expect(fakeApi().getDailyUsage).toHaveBeenCalled());
    expect(screen.queryByText(/Today:/)).not.toBeInTheDocument();
  });
  it("shows free-model requests left on the user's own OpenRouter key", async () => {
    vi.mocked(fakeApi().getDailyUsage).mockResolvedValue({
      date: "2026-10-08",
      tokens: 100,
      provider: "free",
      keyInfo: { isFreeTier: true, dailyRequestLimit: 50, dailyRequestsUsed: 46, dailyRequestsRemaining: 4 },
    });
    renderWithProviders(bar());
    const left = await screen.findByText("4 req left today");
    expect(left.closest(".seg")).toHaveClass("allowance-warn");
  });

  it("falls back to the free tier's daily limit when OpenRouter gives no count", async () => {
    vi.mocked(fakeApi().getDailyUsage).mockResolvedValue({
      date: "2026-10-08",
      tokens: 0,
      provider: "free",
      keyInfo: { isFreeTier: true, dailyRequestLimit: 50 },
    });
    renderWithProviders(bar());
    expect(await screen.findByText("free tier · limit 50/day")).toBeInTheDocument();
  });

  it("prefers the gateway's requests-left header", async () => {
    vi.mocked(fakeApi().getDailyUsage).mockResolvedValue({
      date: "2026-10-08",
      tokens: 0,
      provider: "free",
      allowance: { remainingRequests: 0, resetUtc: "2026-10-09T00:00:00.000Z" },
    });
    renderWithProviders(bar());
    expect((await screen.findByText("0 req left today")).closest(".seg")).toHaveClass("allowance-out");
    expect(screen.queryByText(/left · resets/)).not.toBeInTheDocument();
  });
});
