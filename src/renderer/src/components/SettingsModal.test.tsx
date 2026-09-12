import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_INFO } from "@shared/providers";
import { DEFAULT_PROVIDER_SETTINGS } from "@shared/types";
import { fakeApi } from "../../test/fake-api";
import { renderWithProviders } from "../../test/render";
import { SettingsModal } from "./SettingsModal";

function renderModal(onSaved = vi.fn(), onClose = vi.fn()) {
  renderWithProviders(
    <SettingsModal theme="dark" scale={1} onThemeChange={vi.fn()} onScaleChange={vi.fn()} onClose={onClose} onSaved={onSaved} />,
  );
  return { onSaved, onClose };
}

describe("SettingsModal", () => {
  it("fills model and endpoint from the provider registry when switching providers", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("tab", { name: "Model provider" }));
    await user.selectOptions(screen.getByLabelText("Provider"), "groq");

    expect(screen.getByLabelText("Model")).toHaveValue(PROVIDER_INFO.groq.defaultModel);
    expect(screen.getByLabelText("Base URL")).toHaveValue(PROVIDER_INFO.groq.defaultBaseUrl);
    expect(screen.getByRole("option", { name: PROVIDER_INFO.ollama.label })).toBeInTheDocument();
  });

  it("marks the API key optional only for providers that don't need one", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("tab", { name: "Model provider" }));
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Paste your key");
    await user.selectOptions(screen.getByLabelText("Provider"), "ollama");
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Not required");
  });

  it("saves the exact settings, accepting a decimal comma in the exchange rate", async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = renderModal();
    await waitFor(() => expect(fakeApi().getSettings).toHaveBeenCalled());

    await user.click(screen.getByRole("tab", { name: "Costs" }));
    await user.selectOptions(screen.getByLabelText("Display currency"), "RWF");
    await user.type(screen.getByLabelText(/Exchange rate/), "1450,5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const expected = { ...DEFAULT_PROVIDER_SETTINGS, currency: "RWF", exchangeRate: 1450.5 };
    await waitFor(() => expect(fakeApi().saveSettings).toHaveBeenCalledWith(expected));
    expect(onSaved).toHaveBeenCalledWith(expected);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("won't save an invalid exchange rate", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("tab", { name: "Costs" }));
    await user.selectOptions(screen.getByLabelText("Display currency"), "EUR");
    await user.type(screen.getByLabelText(/Exchange rate/), "-3");

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
