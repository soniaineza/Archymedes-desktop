import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_INFO } from "@shared/providers";
import { DEFAULT_PROVIDER_SETTINGS } from "@shared/types";
import type { ModelListing, ModelListRequest } from "@shared/model-catalog";
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
    // The default, free mode, asks for an OpenRouter key in its own setup card.
    expect(await screen.findByLabelText("OpenRouter API key")).toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Provider"), "anthropic");
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

  describe("model picker", () => {
    const anthropicListing = (request: ModelListRequest): ModelListing => ({
      provider: request.provider,
      status: "ok",
      fetchedAt: Date.now(),
      known: [
        { id: "claude-sonnet-5", isDefault: true, price: { currency: "USD", inputPerMillion: 3_000_000, outputPerMillion: 15_000_000 } },
        { id: "claude-opus-5", isDefault: false, price: { currency: "USD", inputPerMillion: 5_000_000, outputPerMillion: 25_000_000 } },
      ],
      live: [{ id: "claude-opus-6", isDefault: false, live: true }],
    });

    async function openProviderTab(provider: string) {
      const user = userEvent.setup();
      renderModal();
      await waitFor(() => expect(fakeApi().getSettings).toHaveBeenCalled());
      await user.click(screen.getByRole("tab", { name: "Model provider" }));
      await user.selectOptions(screen.getByLabelText("Provider"), provider);
      return user;
    }

    it("offers OpenRouter and Archymedes Cloud with their CLI defaults", async () => {
      await openProviderTab("openrouter");
      expect(screen.getByLabelText("Model")).toHaveValue("openrouter/auto");
      await userEvent.setup().selectOptions(screen.getByLabelText("Provider"), "archymedes-cloud");
      expect(screen.getByLabelText("Model")).toHaveValue("auto");
      expect(screen.getByLabelText("Base URL")).toHaveAttribute("placeholder", "Required: the exchange URL");
    });

    it("lists known models with prices and the default, live models tagged, and picks one", async () => {
      vi.mocked(fakeApi().listModels).mockImplementation(async (request) => anthropicListing(request));
      const user = await openProviderTab("anthropic");
      await waitFor(() => expect(fakeApi().listModels).toHaveBeenCalledWith({ provider: "anthropic", apiKey: "", baseUrl: "" }));

      await user.click(screen.getByLabelText("Model"));
      const list = await screen.findByRole("listbox", { name: "Models" });
      const options = within(list).getAllByRole("option");
      expect(options.map((o) => o.textContent)).toEqual([
        "claude-sonnet-5default$3.00 / $15.00 per M tokens",
        "claude-opus-5$5.00 / $25.00 per M tokens",
        "claude-opus-6liveunpriced",
      ]);

      await user.click(within(list).getByRole("option", { name: /claude-opus-6/ }));
      expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-6");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("filters as you type, supports the keyboard, and keeps a custom id", async () => {
      vi.mocked(fakeApi().listModels).mockImplementation(async (request) => anthropicListing(request));
      const user = await openProviderTab("anthropic");
      const input = screen.getByLabelText("Model");
      await user.clear(input);
      await user.type(input, "opus");
      const list = await screen.findByRole("listbox");
      expect(within(list).getAllByRole("option").map((o) => o.querySelector(".model-option-id")?.textContent)).toEqual(["claude-opus-5", "claude-opus-6"]);

      await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
      expect(input).toHaveValue("claude-opus-6");

      await user.clear(input);
      await user.type(input, "my-private-model{Enter}");
      expect(input).toHaveValue("my-private-model");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fakeApi().saveSettings).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", model: "my-private-model" })));
    });

    it("shows a listing error inline without blocking typing, and refreshes on request", async () => {
      vi.mocked(fakeApi().listModels).mockImplementation(async (request) => ({
        ...anthropicListing(request),
        live: [],
        status: "error",
        error: "provider returned 401",
      }));
      const user = await openProviderTab("openai");
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't fetch the live model list (provider returned 401). You can still type any model ID.");

      const input = screen.getByLabelText("Model");
      await user.clear(input);
      await user.type(input, "gpt-x");
      expect(input).toHaveValue("gpt-x");

      await user.click(screen.getByRole("button", { name: "Refresh model list" }));
      await waitFor(() => expect(fakeApi().listModels).toHaveBeenCalledWith({ provider: "openai", apiKey: "", baseUrl: "", refresh: true }));
    });

    it("explains when a key is needed for the live list", async () => {
      vi.mocked(fakeApi().listModels).mockImplementation(async (request) => ({ provider: request.provider, known: [{ id: "openrouter/auto", isDefault: true }], live: [], status: "no-key" }));
      await openProviderTab("openrouter");
      expect(await screen.findByText("Add an API key to also list the provider's live models. You can type any model ID.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh model list" })).toBeDisabled();
    });
  });
  describe("free mode setup", () => {
    async function openProvider() {
      const user = userEvent.setup();
      const rendered = renderModal();
      await waitFor(() => expect(fakeApi().getSettings).toHaveBeenCalled());
      await user.click(screen.getByRole("tab", { name: "Model provider" }));
      return { user, ...rendered };
    }

    it("explains free mode, links to OpenRouter's key page, and tucks Base URL under Advanced", async () => {
      const { user } = await openProvider();
      expect(
        screen.getByText("Free mode uses free AI models through OpenRouter. Until the Archymedes free service is live you need a free OpenRouter key."),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Get a free key" }));
      expect(fakeApi().openExternal).toHaveBeenCalledWith("https://openrouter.ai/keys");
      const baseUrl = screen.getByLabelText("Base URL");
      expect(baseUrl.closest("details")).not.toHaveAttribute("open");
      expect(screen.getByText("Advanced")).toBeInTheDocument();
    });

    it("saves a new key only after a successful live test", async () => {
      const { user, onSaved } = await openProvider();
      await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-v1-good");
      const save = screen.getByRole("button", { name: "Save" });
      expect(save).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Test key" }));
      expect(fakeApi().checkFreeKey).toHaveBeenCalledWith("sk-or-v1-good");
      expect(await screen.findByText("Key works — free tier, 50 requests/day")).toBeInTheDocument();
      expect(save).toBeEnabled();
      await user.click(save);
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ provider: "free", apiKey: "sk-or-v1-good" })));
    });

    it("shows why a key failed, and allows an explicit Save anyway", async () => {
      vi.mocked(fakeApi().checkFreeKey).mockResolvedValue({ ok: false, reason: "invalid-key", status: 401 });
      const { user } = await openProvider();
      await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-v1-bad");
      await user.click(screen.getByRole("button", { name: "Test key" }));
      expect(await screen.findByText("OpenRouter rejected this key. Check that you copied all of it (it starts with sk-or-).")).toBeInTheDocument();
      const save = screen.getByRole("button", { name: "Save" });
      expect(save).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Save anyway" }));
      expect(save).toBeEnabled();
    });
  });
});
