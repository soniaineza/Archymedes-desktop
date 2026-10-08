import { describe, expect, it } from "vitest";
import { langFromPath, languageLabel, resolveLang, tokenize, tokenizeLines } from "./Highlight";
import type { Token } from "./Highlight";

/** Class of the first token whose text is exactly `text` (across all lines). */
function clsOf(lines: Token[][], text: string): string | null | undefined {
  for (const line of lines) for (const tok of line) if (tok.text === text) return tok.cls;
  return undefined;
}

const joined = (lines: Token[][]): string => lines.map((l) => l.map((t) => t.text).join("")).join("\n");

describe("tokenize", () => {
  it("never changes the text", () => {
    const samples: [string, string][] = [
      ["ts", "const a = `x ${b + 1} y`; // hi\nif (a) { return /re[/]x/g.test(a) }"],
      ["tsx", 'return <div className="a">{items.map((i) => <Item key={i} />)}</div>;'],
      ["python", 'def f(x):\n    """doc\n    more"""\n    return f"{x}" # c'],
      ["css", ".a:hover { color: #fff; margin: 0 2px; }"],
      ["html", '<!-- c --><a href="x">t &amp; u</a>'],
      ["yaml", "key: value # c\nlist:\n  - 1"],
      ["markdown", "# Title\n- **bold** and `code`"],
      ["rust", "fn main<'a>(x: &'a str) { println!(\"{}\", 'c'); }"],
      ["toml", '[pkg]\nname = "x" # c'],
    ];
    for (const [lang, code] of samples) expect(joined(tokenize(code, lang))).toBe(code);
  });

  it("separates declaration keywords from control keywords", () => {
    const lines = tokenize("const x = await f();\nif (x) return x;", "ts");
    expect(clsOf(lines, "const")).toBe("tok-keyword");
    expect(clsOf(lines, "await")).toBe("tok-control");
    expect(clsOf(lines, "if")).toBe("tok-control");
    expect(clsOf(lines, "return")).toBe("tok-control");
  });

  it("recognises functions, properties, types, variables and constants", () => {
    const lines = tokenize("const user: User = api.load(id).name ?? null;", "ts");
    expect(clsOf(lines, "User")).toBe("tok-type");
    expect(clsOf(lines, "load")).toBe("tok-function");
    expect(clsOf(lines, "name")).toBe("tok-property");
    expect(clsOf(lines, "id")).toBe("tok-variable");
    expect(clsOf(lines, "null")).toBe("tok-constant");
  });

  it("tells regex literals from division", () => {
    expect(clsOf(tokenize("const r = /ab+c/gi;", "ts"), "/ab+c/gi")).toBe("tok-regex");
    expect(tokenize("const r = a / b / c;", "ts")[0].some((t) => t.cls === "tok-regex")).toBe(false);
  });

  it("highlights template literal interpolation as code", () => {
    const lines = tokenize("const s = `hi ${user.name}!`;", "ts");
    expect(clsOf(lines, "${")).toBe("tok-keyword");
    expect(clsOf(lines, "name")).toBe("tok-property");
  });

  it("carries block comments and multi-line strings across lines", () => {
    const lines = tokenize("/* a\nb */ x\nconst t = `one\ntwo`;", "ts");
    expect(lines[1][0]).toEqual({ text: "b */", cls: "tok-comment" });
    expect(lines[3][0].cls).toBe("tok-string");
  });

  it("handles decorators and Python strings", () => {
    const lines = tokenize('@app.route("/")\ndef index():\n    return f"hi"  # done', "python");
    expect(clsOf(lines, "@app.route")).toBe("tok-function");
    expect(clsOf(lines, "def")).toBe("tok-keyword");
    expect(clsOf(lines, "index")).toBe("tok-function");
    expect(clsOf(lines, 'f"hi"')).toBe("tok-string");
    expect(clsOf(lines, "# done")).toBe("tok-comment");
  });

  it("highlights JSX tags and attributes", () => {
    const lines = tokenize('return <Button onClick={go} kind="primary">Go now</Button>;', "tsx");
    expect(clsOf(lines, "Button")).toBe("tok-type");
    expect(clsOf(lines, "onClick")).toBe("tok-attr");
    expect(clsOf(lines, '"primary"')).toBe("tok-string");
    expect(clsOf(lines, "Go now")).toBe(null);
  });

  it("does not treat TypeScript generics as JSX", () => {
    const lines = tokenize("const [a, setA] = useState<string>('');", "tsx");
    expect(clsOf(lines, "useState")).toBe("tok-function");
    expect(lines[0].some((t) => t.cls === "tok-tag")).toBe(false);
  });

  it("colours brackets by nesting depth", () => {
    const [line] = tokenize("f(a[b{c}])", "ts");
    const brackets = line.filter((t) => t.cls?.startsWith("tok-bracket"));
    expect(brackets.map((t) => `${t.text}${t.cls!.slice(-1)}`).join(" ")).toBe("(0 [1 {2 }2 ]1 )0");
  });

  it("highlights JSON keys, HTML, CSS, YAML, SQL and shells", () => {
    expect(clsOf(tokenize('{ "name": "x", "n": 1, "ok": true }', "json"), '"name"')).toBe("tok-property");
    expect(clsOf(tokenize('{ "name": "x" }', "json"), '"x"')).toBe("tok-string");

    const html = tokenize('<a href="x">hi</a>', "html");
    expect(clsOf(html, "a")).toBe("tok-tag");
    expect(clsOf(html, "href")).toBe("tok-attr");

    const css = tokenize(".btn:hover {\n  color: red;\n  margin: 4px;\n}", "css");
    expect(clsOf(css, ".btn:hover")).toBe("tok-selector");
    expect(clsOf(css, "color")).toBe("tok-property");
    expect(clsOf(css, "4px")).toBe("tok-number");

    const yaml = tokenize("name: build\non: true", "yaml");
    expect(clsOf(yaml, "name")).toBe("tok-tag");
    expect(clsOf(yaml, "true")).toBe("tok-constant");

    const sql = tokenize("SELECT id FROM users WHERE n > 1 -- c", "sql");
    expect(clsOf(sql, "SELECT")).toBe("tok-keyword");
    expect(clsOf(sql, "-- c")).toBe("tok-comment");

    const sh = tokenize('npm run build && echo "$HOME" # done', "bash");
    expect(clsOf(sh, "npm")).toBe("tok-function");
    expect(clsOf(sh, "echo")).toBe("tok-function");
    expect(clsOf(sh, "# done")).toBe("tok-comment");

    const ps = tokenize("Get-ChildItem -Path $env:TEMP | Where-Object { $_ -eq $true }", "powershell");
    expect(clsOf(ps, "Get-ChildItem")).toBe("tok-function");
    expect(clsOf(ps, "Where-Object")).toBe("tok-function");
    expect(clsOf(ps, "$true")).toBe("tok-constant");
  });

  it("handles Rust lifetimes, chars and macros, Go and C-family", () => {
    const rust = tokenize("fn f<'a>(c: char) { let x = 'z'; println!(\"hi\"); }", "rust");
    expect(clsOf(rust, "'a")).toBe("tok-keyword");
    expect(clsOf(rust, "'z'")).toBe("tok-string");
    expect(clsOf(rust, "println")).toBe("tok-function");
    expect(clsOf(rust, "char")).toBe("tok-type");

    expect(clsOf(tokenize("func main() { defer f(); return }", "go"), "func")).toBe("tok-keyword");
    expect(clsOf(tokenize("#include <stdio.h>\nint main() {}", "c"), "#include")).toBe("tok-control");
  });

  it("highlights markdown and diffs", () => {
    const md = tokenize("## Heading\n- item with `code`", "md");
    expect(md[0][0].cls).toBe("tok-heading");
    expect(clsOf(md, "`code`")).toBe("tok-string");
    const diff = tokenize("@@ -1 +1 @@\n-old\n+new", "diff");
    expect(diff.map((l) => l[0].cls)).toEqual(["tok-hunk", "tok-deleted", "tok-inserted"]);
  });

  it("leaves plain text alone", () => {
    expect(tokenize("if this is text", "text")).toEqual([[{ text: "if this is text", cls: null }]]);
  });

  it("tokenizes diff rows independently", () => {
    const rows = tokenizeLines(["const s = `open", "x + 1"], "ts");
    expect(clsOf([rows[1]], "x")).toBe("tok-variable");
  });
});

describe("language helpers", () => {
  it("resolves aliases and paths", () => {
    expect(resolveLang("TypeScript")).toBe("ts");
    expect(resolveLang("py")).toBe("python");
    expect(resolveLang("whatever")).toBe("generic");
    expect(langFromPath("src/App.tsx")).toBe("tsx");
    expect(langFromPath("Dockerfile")).toBe("dockerfile");
    expect(langFromPath("notes")).toBe("text");
    expect(languageLabel("ts")).toBe("TypeScript");
  });
});
