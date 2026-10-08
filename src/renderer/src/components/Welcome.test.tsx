import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "@shared/types";
import { fakeApi } from "../../test/fake-api";
import { renderWithProviders } from "../../test/render";
import { Welcome } from "./Welcome";

// The animated hero needs WebGL, which jsdom lacks.
vi.mock("./HeroCanvas", () => ({ HeroCanvas: () => null }));

describe("Welcome free mode setup", () => {
  it("sets up free mode with a tested OpenRouter key when no provider works yet", async () => {
    const user = userEvent.setup();
    const onSettingsSaved = vi.fn();
    renderWithProviders(
      <Welcome
        theme="dark"
        onPick={vi.fn()}
        onOpenPath={vi.fn()}
        onCycleTheme={vi.fn()}
        freeSetup
        onSettingsSaved={onSettingsSaved}
      />,
    );
    expect(screen.getByRole("heading", { name: "Free mode" })).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save key" });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-v1-good");
    await user.click(screen.getByRole("button", { name: "Test key" }));
    expect(await screen.findByText("Key works — free tier, 50 requests/day")).toBeInTheDocument();
    await user.click(save);

    const expected = { ...DEFAULT_PROVIDER_SETTINGS, provider: "free", apiKey: "sk-or-v1-good" };
    await waitFor(() => expect(fakeApi().saveSettings).toHaveBeenCalledWith(expected));
    expect(onSettingsSaved).toHaveBeenCalledWith(expected);
  });

  it("stays out of the way when free mode already works", () => {
    renderWithProviders(
      <Welcome theme="dark" onPick={vi.fn()} onOpenPath={vi.fn()} onCycleTheme={vi.fn()} />,
    );
    expect(screen.queryByText("Free mode")).not.toBeInTheDocument();
  });
});
