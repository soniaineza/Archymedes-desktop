import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/render";
import { reloadPrefs, setPref } from "../lib/prefs";
import type { OpenTab } from "../lib/tabs";
import { CodeEditor } from "./CodeEditor";

beforeEach(() => reloadPrefs());

function renderEditor(tab: OpenTab, handlers: Partial<Record<"onClose" | "onChange" | "onSave" | "onBlur", ReturnType<typeof vi.fn>>> = {}) {
  const props = {
    onClose: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    onBlur: vi.fn(),
    ...handlers,
  };
  const result = renderWithProviders(
    <CodeEditor tabs={[tab]} activeTab={tab.path} onActivate={vi.fn()} {...props} />,
  );
  return { ...result, ...props };
}

describe("CodeEditor", () => {
  it("never closes a tab with unsaved work on Escape", () => {
    const { onClose } = renderEditor({ path: "a.ts", content: "changed", original: "orig" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "a.ts" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("indents with the configured tab size", () => {
    setPref("editorTabSize", 4);
    const { onChange } = renderEditor({ path: "a.ts", content: "x", original: "x" });
    const area = screen.getByRole("textbox", { name: "a.ts" }) as HTMLTextAreaElement;
    area.setSelectionRange(0, 0);
    fireEvent.keyDown(area, { key: "Tab" });
    expect(onChange).toHaveBeenCalledWith("a.ts", "    x");
  });

  it("highlights the current line and shows line numbers", () => {
    const { container } = renderEditor({ path: "a.ts", content: "const a = 1;\nlet b;", original: "" });
    expect(container.querySelectorAll(".editor-gutter .ln")).toHaveLength(2);
    expect(container.querySelector(".hl-line.current")?.textContent).toBe("const a = 1;");
  });

  it("wraps lines and moves numbers inline when word wrap is on", () => {
    setPref("editorWordWrap", true);
    const { container } = renderEditor({ path: "a.ts", content: "x", original: "x" });
    expect(container.querySelector(".editor-wrap.wrap.numbers")).not.toBeNull();
    expect(container.querySelector(".editor-gutter")).toBeNull();
  });

  it("reports blur for auto save on focus change", () => {
    const { onBlur } = renderEditor({ path: "a.ts", content: "x", original: "y" });
    fireEvent.blur(screen.getByRole("textbox", { name: "a.ts" }));
    expect(onBlur).toHaveBeenCalledWith("a.ts");
  });
});
