import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test/render";
import { parseUnifiedDiff } from "./DiffRows";
import { MarkdownLite, parseFenceInfo } from "./MarkdownLite";

describe("parseFenceInfo", () => {
  it("reads languages and file names from fence info strings", () => {
    expect(parseFenceInfo("ts")).toEqual({ lang: "ts", file: null });
    expect(parseFenceInfo("")).toEqual({ lang: "text", file: null });
    expect(parseFenceInfo("ts:src/a.ts")).toEqual({ lang: "ts", file: "src/a.ts" });
    expect(parseFenceInfo('tsx title="src/App.tsx"')).toEqual({ lang: "tsx", file: "src/App.tsx" });
    expect(parseFenceInfo("python filename=main.py")).toEqual({ lang: "python", file: "main.py" });
    expect(parseFenceInfo("src/lib/util.rs")).toEqual({ lang: "rs", file: "src/lib/util.rs" });
    expect(parseFenceInfo("c++")).toEqual({ lang: "c++", file: null });
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers old and new lines from hunk headers and finds the path", () => {
    const { rows, path } = parseUnifiedDiff("--- a/src/x.ts\n+++ b/src/x.ts\n@@ -10,3 +10,3 @@\n keep\n-old\n+new");
    expect(path).toBe("src/x.ts");
    expect(rows.slice(3)).toEqual([
      { kind: "ctx", text: "keep", oldLine: 10, newLine: 10 },
      { kind: "del", text: "old", oldLine: 11 },
      { kind: "add", text: "new", newLine: 11 },
    ]);
  });
});

describe("MarkdownLite code blocks", () => {
  it("shows the file name and language in the title bar and highlights the code", () => {
    const { container } = renderWithProviders(<MarkdownLite text={"```ts title=src/a.ts\nconst x = 1;\n```"} />);
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(container.querySelector(".tok-keyword")?.textContent).toBe("const");
  });

  it("renders diffs as rows with gutters and syntax colours", () => {
    const { container } = renderWithProviders(
      <MarkdownLite text={"```diff\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-let a = 1;\n+const a = 2;\n```"} />,
    );
    const add = container.querySelector(".diff-row.add");
    expect(add?.querySelector(".sign")?.textContent).toBe("+");
    expect(add?.querySelectorAll(".ln")[1]?.textContent).toBe("1");
    expect(add?.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(container.querySelector(".diff-row.del .tok-keyword")?.textContent).toBe("let");
  });
});
