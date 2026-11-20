import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import { Root } from "./Root";

// The workbench welcome hero needs WebGL, which jsdom lacks.
vi.mock("./components/HeroCanvas", () => ({ HeroCanvas: () => null }));

describe("Root mode switch", () => {
  it("opens on the enterprise OS by default", async () => {
    renderWithProviders(<Root />);
    expect(await screen.findByRole("heading", { name: /Archymedes\s*Desktop/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archymedes OS/ })).not.toBeInTheDocument();
  });

  it("switches to the workbench, remembers it, and switches back", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<Root />);
    await user.click(await screen.findByRole("button", { name: /coding workbench/ }));
    expect(await screen.findByRole("button", { name: /Archymedes OS/ })).toBeInTheDocument();
    expect(localStorage.getItem("archymedes.mode")).toBe("workbench");

    unmount();
    renderWithProviders(<Root />);
    const back = await screen.findByRole("button", { name: /Archymedes OS/ });
    await user.click(back);
    expect(await screen.findByRole("heading", { name: /Archymedes\s*Desktop/ })).toBeInTheDocument();
    expect(localStorage.getItem("archymedes.mode")).toBe("enterprise");
  });
});
