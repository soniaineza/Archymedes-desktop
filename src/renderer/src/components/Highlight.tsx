import { memo } from "react";
import type { ReactNode } from "react";

/**
 * A small, dependency-free, language-aware syntax highlighter with VS Code-style
 * token classes. Each language is described by a tiny grammar (comments, quotes,
 * keyword sets, a few feature flags); markup, CSS, YAML, TOML, Markdown and diffs
 * get dedicated line tokenizers. Multi-line constructs (block comments, template
 * literals, triple-quoted strings, open tags, CSS blocks, fences) carry over from
 * one line to the next through a small mutable state object.
 *
 * Output classes (coloured in styles.css through --tok-* variables per theme):
 *   tok-keyword  declarations / storage (const, function, class, def, fn…)
 *   tok-control  flow + modules (if, return, await, import, export…)
 *   tok-constant true/false/null/this/self
 *   tok-string tok-escape tok-number tok-comment tok-regex
 *   tok-function tok-type tok-variable tok-property tok-operator tok-punctuation
 *   tok-tag tok-attr tok-selector tok-heading tok-bold tok-italic
 *   tok-bracket-0/1/2 (bracket pair colourisation by nesting depth)
 *   tok-inserted tok-deleted tok-hunk (diffs)
 */

export type Token = { text: string; cls: string | null };

type Block =
  | { kind: "comment"; end: string }
  | { kind: "string"; end: string; cls: string; interp: boolean }
  | { kind: "fence" };

interface State {
  block: Block | null;
  /** Bracket nesting depth for pair colourisation. */
  depth: number;
  /** Inside an HTML/XML/JSX tag's attribute list. */
  tag: null | "html" | "jsx";
  tagClosing: boolean;
  /** Open JSX elements: text between tags is plain. */
  jsx: number;
  /** CSS rule nesting and whether we are inside a declaration value. */
  css: number;
  cssValue: boolean;
}

const newState = (): State => ({ block: null, depth: 0, tag: null, tagClosing: false, jsx: 0, css: 0, cssValue: false });

// ---------------------------------------------------------------------------
// Grammars
// ---------------------------------------------------------------------------

interface CodeGrammar {
  kind: "code";
  lineComment: string[];
  blockComment?: [string, string];
  /** Characters that open a string. */
  quotes: string;
  /** Quote characters whose strings may span lines (` in JS/Go). */
  multiline?: string;
  /** Python-style """ / ''' strings. */
  triple?: boolean;
  /** Prefix letters glued to a quote (Python r"", f"", b""; C# @"" $""). */
  stringPrefix?: RegExp;
  /** `${…}` interpolation inside backtick strings. */
  interp?: boolean;
  regex?: boolean;
  jsx?: boolean;
  decorators?: boolean;
  /** Rust `name!` macros and 'lifetimes. */
  rust?: boolean;
  /** C-family `#include`/`#define` lines. */
  preprocessor?: boolean;
  /** Shell / PowerShell `$VAR`, `${VAR}`, `$1`. */
  dollarVars?: boolean;
  /** First word of a shell command is a function. */
  commands?: boolean;
  caseInsensitive?: boolean;
  /** JSON-style: a string followed by ':' is a key. */
  keyStrings?: boolean;
  /** Identifier pattern (sticky). */
  ident: RegExp;
  /** Class for identifiers that are nothing else. */
  identCls: string | null;
  keywords: Set<string>;
  control: Set<string>;
  constants: Set<string>;
  types: Set<string>;
}

interface SpecialGrammar {
  kind: "markup" | "css" | "yaml" | "toml" | "markdown" | "diff" | "plain";
  /** CSS dialects with // comments. */
  slashComments?: boolean;
}

type Grammar = CodeGrammar | SpecialGrammar;

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));
const IDENT = /[A-Za-z_$][\w$]*/y;
const IDENT_NO_DOLLAR = /[A-Za-z_][\w]*/y;

const JS_KEYWORDS = words(
  "const let var function class extends implements interface type enum namespace module declare abstract public private protected readonly static async get set new delete typeof instanceof in of keyof infer as satisfies is void override accessor unique asserts",
);
const JS_CONTROL = words(
  "if else for while do switch case default break continue return throw try catch finally await yield import export from with debugger",
);
const JS_CONSTANTS = words("true false null undefined this super NaN Infinity");
const JS_TYPES = words("string number boolean any unknown never object symbol bigint");

const code = (g: Omit<CodeGrammar, "kind" | "ident" | "identCls"> & Partial<Pick<CodeGrammar, "ident" | "identCls">>): CodeGrammar => ({
  kind: "code",
  ident: IDENT_NO_DOLLAR,
  identCls: "tok-variable",
  ...g,
});

const JS = code({
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: "\"'`",
  multiline: "`",
  interp: true,
  regex: true,
  decorators: true,
  ident: IDENT,
  keywords: JS_KEYWORDS,
  control: JS_CONTROL,
  constants: JS_CONSTANTS,
  types: JS_TYPES,
});
const JSX: CodeGrammar = { ...JS, jsx: true };

const PYTHON = code({
  lineComment: ["#"],
  quotes: "\"'",
  triple: true,
  stringPrefix: /(?:[rR][bBfF]?|[bBfF][rR]?|[uU])(?=["'])/y,
  decorators: true,
  keywords: words("def class lambda global nonlocal and or not in is async del"),
  control: words("if elif else for while break continue return pass try except finally raise with as import from yield await assert match case"),
  constants: words("True False None self cls"),
  types: words("int str float bool list dict set tuple bytes object type frozenset complex"),
});

const RUST = code({
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: "\"",
  multiline: "\"",
  rust: true,
  keywords: words("fn let mut const static struct enum trait impl type mod pub use crate extern unsafe where dyn ref move as async union"),
  control: words("if else match for while loop break continue return in await yield"),
  constants: words("true false self Self super"),
  types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str"),
});

const GO = code({
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: "\"'`",
  multiline: "`",
  keywords: words("func var const type struct interface map chan defer go"),
  control: words("if else for range switch case default break continue return goto fallthrough select import package"),
  constants: words("true false nil iota"),
  types: words("int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any"),
});

const C_LIKE = code({
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: "\"'",
  stringPrefix: /(?:@\$?|\$@?|[LuUR]|u8)(?=")/y,
  preprocessor: true,
  decorators: true,
  keywords: words(
    "class interface enum struct union typedef namespace using public private protected internal static final abstract virtual override const constexpr volatile extern inline new delete sizeof typename template auto var val let fun func operator readonly sealed partial async extends implements record data object companion lateinit open suspend fn def mutable explicit friend unsafe fixed event delegate get set init where",
  ),
  control: words(
    "if else for foreach while do switch case default break continue return throw throws try catch finally goto await yield when in is as import package include",
  ),
  constants: words("true false null nullptr this super self NULL base it"),
  types: words(
    "int long short char float double bool boolean byte string void unsigned signed size_t uint ulong ushort sbyte decimal dynamic object Unit Int Long Double Float Boolean Char",
  ),
});

const SHELL = code({
  lineComment: ["#"],
  quotes: "\"'",
  dollarVars: true,
  commands: true,
  ident: /[A-Za-z_][\w.-]*/y,
  identCls: null,
  keywords: words("export local declare readonly alias unset source typeset"),
  control: words("if then else elif fi for while until do done case esac in return exit break continue function select time"),
  constants: words("true false"),
  types: new Set(),
});

const POWERSHELL = code({
  lineComment: ["#"],
  blockComment: ["<#", "#>"],
  quotes: "\"'",
  dollarVars: true,
  commands: true,
  caseInsensitive: true,
  ident: /[A-Za-z_][\w]*(?:-[A-Za-z]\w*)*/y,
  identCls: null,
  keywords: words("function param begin process end filter class enum using dynamicparam"),
  control: words("if elseif else foreach for while do until switch break continue return try catch finally throw trap exit in"),
  constants: words("$true $false $null"),
  types: new Set(),
});

const SQL = code({
  lineComment: ["--"],
  blockComment: ["/*", "*/"],
  quotes: "'\"`",
  caseInsensitive: true,
  identCls: null,
  keywords: words(
    "select from where insert into values update set delete create table alter drop index view join inner left right outer full cross on as and or not is in exists between like ilike limit offset order by group having union all distinct case when then else end primary key foreign references default unique check constraint if begin commit rollback transaction with returning asc desc replace temporary temp database schema grant revoke truncate add column rename to cascade",
  ),
  control: new Set(),
  constants: words("true false null"),
  types: words("int integer bigint smallint tinyint text varchar char boolean bool date time timestamp timestamptz float real double decimal numeric serial bigserial uuid json jsonb blob bytea"),
});

const JSON_G = code({
  lineComment: ["//"],
  blockComment: ["/*", "*/"],
  quotes: "\"",
  keyStrings: true,
  identCls: null,
  keywords: new Set(),
  control: new Set(),
  constants: words("true false null"),
  types: new Set(),
});

const GENERIC = code({
  lineComment: ["//", "#"],
  blockComment: ["/*", "*/"],
  quotes: "\"'`",
  keywords: new Set([...JS_KEYWORDS, ...PYTHON.keywords, ...RUST.keywords]),
  control: new Set([...JS_CONTROL, ...PYTHON.control]),
  constants: new Set([...JS_CONSTANTS, ...PYTHON.constants]),
  types: new Set(),
});

const RUBY = code({
  lineComment: ["#"],
  quotes: "\"'",
  keywords: words("def class module lambda proc alias and or not attr_accessor attr_reader attr_writer"),
  control: words("if elsif else unless case when while until for in do end break next redo retry return yield begin rescue ensure raise require require_relative include extend then"),
  constants: words("true false nil self"),
  types: new Set(),
});

const LANG_ALIASES: Record<string, string> = {
  ts: "ts", typescript: "ts", mts: "ts", cts: "ts",
  tsx: "tsx", jsx: "tsx", js: "tsx", javascript: "tsx", mjs: "tsx", cjs: "tsx", node: "tsx",
  py: "python", python: "python", python3: "python", pyw: "python", pyi: "python",
  rs: "rust", rust: "rust",
  go: "go", golang: "go",
  java: "c", cs: "c", csharp: "c", "c#": "c", c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", cxx: "c", hpp: "c", hh: "c",
  kt: "c", kotlin: "c", kts: "c", swift: "c", scala: "c", dart: "c", php: "c", groovy: "c", gradle: "c", m: "c", objc: "c",
  rb: "ruby", ruby: "ruby",
  json: "json", jsonc: "json", json5: "json", geojson: "json",
  html: "html", htm: "html", xml: "html", svg: "html", xhtml: "html", vue: "html", svelte: "html", xaml: "html", plist: "html",
  csproj: "html", vcxproj: "html",
  css: "css", scss: "scss", sass: "scss", less: "scss",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", shellscript: "shell", fish: "shell",
  dockerfile: "shell", docker: "shell", makefile: "shell", make: "shell", env: "shell",
  ps1: "powershell", psm1: "powershell", psd1: "powershell", powershell: "powershell", pwsh: "powershell", ps: "powershell",
  bat: "shell", cmd: "shell",
  sql: "sql", psql: "sql", mysql: "sql", sqlite: "sql", pgsql: "sql",
  yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "toml", cfg: "toml", conf: "toml", properties: "toml", editorconfig: "toml", gitconfig: "toml",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  diff: "diff", patch: "diff",
  txt: "plain", text: "plain", plain: "plain", plaintext: "plain", log: "plain", "": "plain", output: "plain",
};

const GRAMMARS: Record<string, Grammar> = {
  ts: JS,
  tsx: JSX,
  python: PYTHON,
  rust: RUST,
  go: GO,
  c: C_LIKE,
  ruby: RUBY,
  json: JSON_G,
  shell: SHELL,
  powershell: POWERSHELL,
  sql: SQL,
  html: { kind: "markup" },
  css: { kind: "css" },
  scss: { kind: "css", slashComments: true },
  yaml: { kind: "yaml" },
  toml: { kind: "toml" },
  markdown: { kind: "markdown" },
  diff: { kind: "diff" },
  plain: { kind: "plain" },
  generic: GENERIC,
};

const LABELS: Record<string, string> = {
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", js: "JavaScript", javascript: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", python: "Python", rs: "Rust", rust: "Rust", go: "Go", golang: "Go", java: "Java", cs: "C#", csharp: "C#", c: "C", h: "C",
  cpp: "C++", "c++": "C++", hpp: "C++", cc: "C++", kt: "Kotlin", kotlin: "Kotlin", swift: "Swift", php: "PHP", rb: "Ruby", ruby: "Ruby",
  json: "JSON", jsonc: "JSON", html: "HTML", xml: "XML", svg: "SVG", vue: "Vue", css: "CSS", scss: "SCSS", less: "Less",
  sh: "Shell", bash: "Bash", zsh: "Zsh", shell: "Shell", console: "Console", powershell: "PowerShell", ps1: "PowerShell", pwsh: "PowerShell",
  sql: "SQL", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI", md: "Markdown", markdown: "Markdown", diff: "Diff", patch: "Diff",
  dockerfile: "Dockerfile", text: "Plain text", txt: "Plain text", plain: "Plain text",
};

/** Canonical grammar id for a fence language or extension ("typescript" → "ts"). */
export function resolveLang(lang: string): string {
  const key = lang.trim().toLowerCase();
  return LANG_ALIASES[key] ?? (GRAMMARS[key] ? key : "generic");
}

/** Human-friendly language name for a code-block title bar. */
export function languageLabel(lang: string): string {
  const key = lang.trim().toLowerCase();
  return LABELS[key] ?? (key || "text");
}

/** Language id for a file path, by extension or well-known file name. */
export function langFromPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name.startsWith(".env")) return "env";
  if (name === ".gitignore" || name === ".npmrc") return "shell";
  if (!name.includes(".")) return "text";
  const ext = name.split(".").pop() ?? "";
  return LANG_ALIASES[ext] ? ext : "text";
}

// ---------------------------------------------------------------------------
// Tokenizer helpers
// ---------------------------------------------------------------------------

const NON_SPACE = /\S/;
const KEY_COLON = /\s*:/y;

class Out {
  tokens: Token[] = [];
  /** Last significant (non-whitespace) token. */
  last: Token | null = null;
  push(text: string, cls: string | null): void {
    if (!text) return;
    const prev = this.tokens[this.tokens.length - 1];
    if (prev && prev.cls === cls && cls !== null && !cls.startsWith("tok-bracket")) prev.text += text;
    else this.tokens.push({ text, cls });
    if (NON_SPACE.test(text)) this.last = { text, cls };
  }
}

function at(re: RegExp, line: string, i: number): string | null {
  re.lastIndex = i;
  const m = re.exec(line);
  return m ? m[0] : null;
}

const WS = /[ \t]+/y;
const NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.(?!\.)[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?:n|(?:[iu](?:8|16|32|64|128|size)|f32|f64)|[fFdDlLuUmM]{1,3})?(?![\w$])/y;
const OPERATOR = /(?:=>|\.\.\.|::|->|[-+*/%=&|^!<>~?:]+)/y;
const REGEX_LITERAL = /\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuyv]*/y;
/** A call: optional generic arguments, then "(". */
const CALL = /(?:\s*<[\w\s,.[\]|<>]*>)?\s*\(/y;
const ESCAPE = /\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[0-7]{1,3}|.)?/y;
const OPEN = "([{";
const CLOSE = ")]}";

function bracket(out: Out, st: State, ch: string): void {
  if (OPEN.includes(ch)) {
    out.push(ch, `tok-bracket-${st.depth % 3}`);
    st.depth++;
  } else {
    st.depth = Math.max(0, st.depth - 1);
    out.push(ch, `tok-bracket-${st.depth % 3}`);
  }
}

/** Where an expression may start: regex literals and JSX tags are allowed here. */
function expressionStart(out: Out): boolean {
  const last = out.last;
  if (!last) return true;
  if (last.cls === "tok-control" || last.cls === "tok-keyword") return true;
  if (last.cls === "tok-operator") return true;
  if (last.cls === "tok-punctuation") return last.text !== ".";
  if (last.cls?.startsWith("tok-bracket")) return OPEN.includes(last.text[last.text.length - 1] ?? "");
  return false;
}

/** Index just past the `}` that closes the `{` at `from`, or -1 if it is not on this line. */
function matchBrace(line: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = from; j < line.length; j++) {
    const c = line[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * Emit a string body starting at `i` (after the opening quote), splitting escapes and `${…}`
 * interpolations. Returns the index after the closing delimiter, or -1 if the line ended first.
 */
function stringBody(line: string, i: number, end: string, cls: string, interp: boolean, g: CodeGrammar, st: State, out: Out): number {
  let start = i;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      out.push(line.slice(start, i), cls);
      const m = at(ESCAPE, line, i) ?? "\\";
      out.push(m, "tok-escape");
      i += m.length;
      start = i;
      continue;
    }
    if (line.startsWith(end, i)) {
      out.push(line.slice(start, i + end.length), cls);
      return i + end.length;
    }
    if (interp && c === "$" && line[i + 1] === "{") {
      const close = matchBrace(line, i + 1);
      if (close !== -1) {
        out.push(line.slice(start, i), cls);
        out.push("${", "tok-keyword");
        const inner = { ...newState(), depth: st.depth };
        codeLine(line.slice(i + 2, close - 1), g, inner, out);
        out.push("}", "tok-keyword");
        i = close;
        start = i;
        continue;
      }
    }
    i++;
  }
  out.push(line.slice(start), cls);
  return -1;
}

// ---------------------------------------------------------------------------
// Code tokenizer
// ---------------------------------------------------------------------------

function tag(line: string, i: number, st: State, g: CodeGrammar | null, out: Out): number {
  // Inside a tag's attribute list until `>` or `/>`.
  while (i < line.length) {
    const ws = at(WS, line, i);
    if (ws) {
      out.push(ws, null);
      i += ws.length;
      continue;
    }
    if (line.startsWith("/>", i) || line.startsWith("?>", i)) {
      out.push(line.slice(i, i + 2), "tok-punctuation");
      st.tag = null;
      return i + 2;
    }
    const c = line[i];
    if (c === ">") {
      out.push(">", "tok-punctuation");
      if (st.tag === "jsx") st.jsx = st.tagClosing ? Math.max(0, st.jsx - 1) : st.jsx + 1;
      st.tag = null;
      return i + 1;
    }
    if (c === '"' || c === "'") {
      const close = line.indexOf(c, i + 1);
      const endIdx = close === -1 ? line.length : close + 1;
      out.push(line.slice(i, endIdx), "tok-string");
      i = endIdx;
      continue;
    }
    if (c === "{" && g) {
      const close = matchBrace(line, i);
      if (close === -1) {
        // A multi-line attribute expression: fall back to plain code for the rest.
        st.tag = null;
        return i;
      }
      bracket(out, st, "{");
      codeLine(line.slice(i + 1, close - 1), g, st, out, true);
      bracket(out, st, "}");
      i = close;
      continue;
    }
    if (c === "=") {
      out.push("=", "tok-operator");
      i++;
      continue;
    }
    const attr = at(/[A-Za-z_:@#.][\w:.-]*/y, line, i);
    if (attr) {
      out.push(attr, "tok-attr");
      i += attr.length;
      continue;
    }
    out.push(c, "tok-punctuation");
    i++;
  }
  return i;
}

/** `<name` or `</name` (called with `i` at `<`); leaves the state inside the tag. */
function openTag(line: string, i: number, st: State, kind: "html" | "jsx", out: Out): number {
  const closing = line[i + 1] === "/";
  const punct = closing ? "</" : "<";
  out.push(punct, "tok-punctuation");
  i += punct.length;
  const name = at(/[A-Za-z][\w.:-]*/y, line, i) ?? "";
  if (kind === "jsx" && name === "" && line[i] === ">") {
    // Fragment <> or </>
    out.push(">", "tok-punctuation");
    st.jsx = closing ? Math.max(0, st.jsx - 1) : st.jsx + 1;
    return i + 1;
  }
  out.push(name, kind === "jsx" && (/^[A-Z]/.test(name) || name.includes(".")) ? "tok-type" : "tok-tag");
  st.tag = kind;
  st.tagClosing = closing;
  return i + name.length;
}

function codeLine(line: string, g: CodeGrammar, st: State, out: Out, nested = false): void {
  let i = 0;
  const n = line.length;
  let commandPos = Boolean(g.commands);

  while (i < n) {
    // ---- Continuations from previous lines
    if (st.block?.kind === "comment") {
      const end = line.indexOf(st.block.end, i);
      if (end === -1) {
        out.push(line.slice(i), "tok-comment");
        return;
      }
      out.push(line.slice(i, end + st.block.end.length), "tok-comment");
      i = end + st.block.end.length;
      st.block = null;
      continue;
    }
    if (st.block?.kind === "string") {
      const b = st.block;
      const next = stringBody(line, i, b.end, b.cls, b.interp, g, st, out);
      if (next === -1) return;
      st.block = null;
      i = next;
      continue;
    }
    if (st.tag && g.jsx) {
      i = tag(line, i, st, g, out);
      continue;
    }

    const c = line[i];

    const ws = at(WS, line, i);
    if (ws) {
      out.push(ws, null);
      i += ws.length;
      continue;
    }

    // ---- JSX children: plain text up to the next tag or expression
    if (g.jsx && st.jsx > 0 && !nested && c === "{") {
      const close = matchBrace(line, i);
      if (close === -1) {
        // An expression that continues on later lines: highlight the rest as code.
        codeLine(line.slice(i), g, st, out, true);
        return;
      }
      bracket(out, st, "{");
      codeLine(line.slice(i + 1, close - 1), g, st, out, true);
      bracket(out, st, "}");
      i = close;
      continue;
    }
    if (g.jsx && st.jsx > 0 && !nested && c !== "<") {
      const stop = line.slice(i).search(/[<{]/);
      const end = stop === -1 ? n : i + stop;
      out.push(line.slice(i, end), null);
      i = end;
      continue;
    }

    // ---- Comments
    let isComment = false;
    for (const lc of g.lineComment) {
      if (line.startsWith(lc, i)) {
        // Shell-style `#` only starts a comment at a word boundary.
        if (lc === "#" && g.dollarVars && i > 0 && !/\s/.test(line[i - 1] ?? "")) continue;
        isComment = true;
        break;
      }
    }
    if (isComment && !(g.preprocessor && c === "#")) {
      out.push(line.slice(i), "tok-comment");
      return;
    }
    if (g.blockComment && line.startsWith(g.blockComment[0], i)) {
      const [open, close] = g.blockComment;
      const end = line.indexOf(close, i + open.length);
      if (end === -1) {
        out.push(line.slice(i), "tok-comment");
        st.block = { kind: "comment", end: close };
        return;
      }
      out.push(line.slice(i, end + close.length), "tok-comment");
      i = end + close.length;
      continue;
    }

    // ---- Preprocessor
    if (g.preprocessor && c === "#" && line.slice(0, i).trim() === "") {
      const dir = at(/#\s*\w+/y, line, i);
      if (dir) {
        out.push(dir, "tok-control");
        i += dir.length;
        const inc = at(/\s*<[^>\n]*>/y, line, i);
        if (inc) {
          out.push(inc, "tok-string");
          i += inc.length;
        }
        continue;
      }
    }

    // ---- Decorators / annotations
    if (g.decorators && c === "@") {
      const dec = at(/@[A-Za-z_][\w.]*/y, line, i);
      if (dec) {
        out.push(dec, "tok-function");
        i += dec.length;
        continue;
      }
    }

    // ---- Strings
    const prefix = g.stringPrefix ? at(g.stringPrefix, line, i) : null;
    const q = line[i + (prefix?.length ?? 0)];
    if (q && (g.quotes.includes(q) || (g.rust && q === "'")) && (prefix || q === c)) {
      // Rust: 'a is a lifetime unless it is a char literal like 'a' or '\n'.
      if (g.rust && q === "'") {
        const ch = at(/'(?:\\(?:u\{[\da-fA-F]+\}|x[\da-fA-F]{2}|.)|[^'\\])'/y, line, i);
        if (ch) {
          out.push(ch, "tok-string");
          i += ch.length;
          continue;
        }
        const life = at(/'[A-Za-z_]\w*/y, line, i);
        if (life) {
          out.push(life, "tok-keyword");
          i += life.length;
          continue;
        }
      }
      const start = i;
      i += prefix?.length ?? 0;
      const triple = g.triple && line.startsWith(q.repeat(3), i);
      const end = triple ? q.repeat(3) : q;
      const interp = Boolean(g.interp && q === "`");
      out.push(line.slice(start, i + end.length), "tok-string");
      const next = stringBody(line, i + end.length, end, "tok-string", interp, g, st, out);
      if (next === -1) {
        if (triple || g.multiline?.includes(q)) st.block = { kind: "string", end, cls: "tok-string", interp };
        return;
      }
      i = next;
      if (g.keyStrings && at(KEY_COLON, line, i) !== null) {
        // JSON key: recolour the string we just emitted.
        for (let k = out.tokens.length - 1; k >= 0 && out.tokens[k].cls !== null; k--) {
          if (out.tokens[k].cls === "tok-string" || out.tokens[k].cls === "tok-escape") out.tokens[k].cls = "tok-property";
          if (out.tokens[k].text.startsWith(q) && out.tokens[k].cls === "tok-property") break;
        }
      }
      commandPos = false;
      continue;
    }

    // ---- JSX tags
    if (g.jsx && c === "<" && /^(?:[A-Za-z>]|\/[A-Za-z>])/.test(line.slice(i + 1, i + 3)) && (st.jsx > 0 || expressionStart(out))) {
      i = openTag(line, i, st, "jsx", out);
      continue;
    }

    // ---- Regex literals
    if (g.regex && c === "/" && expressionStart(out)) {
      const re = at(REGEX_LITERAL, line, i);
      if (re) {
        out.push(re, "tok-regex");
        i += re.length;
        continue;
      }
    }

    // ---- Shell / PowerShell variables
    if (g.dollarVars && c === "$") {
      const v = at(/\$(?:\{[^}\n]*\}|[A-Za-z_][\w:]*|[0-9#?@*$!-])/y, line, i);
      if (v) {
        const lower = v.toLowerCase();
        out.push(v, g.constants.has(lower) ? "tok-constant" : "tok-variable");
        i += v.length;
        commandPos = false;
        continue;
      }
    }

    // ---- Numbers
    if (/[\d.]/.test(c)) {
      const num = at(NUMBER, line, i);
      if (num && /\d/.test(num)) {
        out.push(num, "tok-number");
        i += num.length;
        commandPos = false;
        continue;
      }
    }

    // ---- Identifiers
    const word = at(g.ident, line, i);
    if (word) {
      const key = g.caseInsensitive ? word.toLowerCase() : word;
      const end = i + word.length;
      const prev = out.last?.text ?? "";
      const isCall = () => {
        CALL.lastIndex = end;
        return CALL.test(line);
      };
      let cls: string | null;
      if (g.rust && line[end] === "!" && line[end + 1] !== "=") cls = "tok-function";
      else if ((prev.endsWith(".") && prev !== "...") || prev === "->" || prev === "?.") {
        cls = isCall() ? "tok-function" : "tok-property";
      } else if (g.control.has(key)) cls = "tok-control";
      else if (g.keywords.has(key)) cls = "tok-keyword";
      else if (g.constants.has(key)) cls = "tok-constant";
      else if (g.types.has(key)) cls = "tok-type";
      else if (commandPos) cls = "tok-function";
      else if (isCall()) cls = "tok-function";
      else if (g.identCls !== null && /^[A-Z]/.test(word) && /[a-z]/.test(word)) cls = "tok-type";
      else cls = g.identCls;
      out.push(word, cls);
      i += word.length;
      if (!g.control.has(key) && !g.keywords.has(key)) commandPos = false;
      continue;
    }

    // ---- Brackets, operators, punctuation
    if (OPEN.includes(c) || CLOSE.includes(c)) {
      bracket(out, st, c);
      i++;
      if (g.commands && (c === "(" || c === "{")) commandPos = true;
      continue;
    }
    if (c === "," || c === ";" || (c === "." && line[i + 1] !== ".")) {
      out.push(c, "tok-punctuation");
      i++;
      if (g.commands && c === ";") commandPos = true;
      continue;
    }
    const op = at(OPERATOR, line, i);
    if (op) {
      out.push(op, "tok-operator");
      i += op.length;
      if (g.commands && /^(?:\||&&|\|\||&)$/.test(op)) commandPos = true;
      continue;
    }
    out.push(c, null);
    i++;
  }
}

// ---------------------------------------------------------------------------
// Special tokenizers
// ---------------------------------------------------------------------------

function markupLine(line: string, st: State, out: Out): void {
  let i = 0;
  while (i < line.length) {
    if (st.block?.kind === "comment") {
      const end = line.indexOf(st.block.end, i);
      if (end === -1) {
        out.push(line.slice(i), "tok-comment");
        return;
      }
      out.push(line.slice(i, end + st.block.end.length), "tok-comment");
      i = end + st.block.end.length;
      st.block = null;
      continue;
    }
    if (st.tag) {
      i = tag(line, i, st, null, out);
      continue;
    }
    if (line.startsWith("<!--", i)) {
      st.block = { kind: "comment", end: "-->" };
      continue;
    }
    if (line.startsWith("<![CDATA[", i)) {
      const end = line.indexOf("]]>", i);
      const stop = end === -1 ? line.length : end + 3;
      out.push(line.slice(i, stop), "tok-string");
      i = stop;
      continue;
    }
    if (line.startsWith("<!", i) || line.startsWith("<?", i)) {
      const kw = at(/<[!?][\w-]*/y, line, i) ?? "<!";
      out.push(kw, "tok-control");
      i += kw.length;
      st.tag = "html";
      st.tagClosing = false;
      continue;
    }
    if (line[i] === "<" && /[A-Za-z/]/.test(line[i + 1] ?? "")) {
      i = openTag(line, i, st, "html", out);
      continue;
    }
    const entity = at(/&(?:#\d+|#x[\da-fA-F]+|\w+);/y, line, i);
    if (entity) {
      out.push(entity, "tok-constant");
      i += entity.length;
      continue;
    }
    const text = at(/[^<&]+/y, line, i) ?? line[i];
    out.push(text, null);
    i += text.length;
  }
}

function cssLine(line: string, g: SpecialGrammar, st: State, out: Out): void {
  let i = 0;
  while (i < line.length) {
    if (st.block?.kind === "comment") {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        out.push(line.slice(i), "tok-comment");
        return;
      }
      out.push(line.slice(i, end + 2), "tok-comment");
      i = end + 2;
      st.block = null;
      continue;
    }
    const c = line[i];
    const ws = at(WS, line, i);
    if (ws) {
      out.push(ws, null);
      i += ws.length;
      continue;
    }
    if (line.startsWith("/*", i)) {
      st.block = { kind: "comment", end: "*/" };
      continue;
    }
    if (g.slashComments && line.startsWith("//", i)) {
      out.push(line.slice(i), "tok-comment");
      return;
    }
    if (c === '"' || c === "'") {
      const close = line.indexOf(c, i + 1);
      const end = close === -1 ? line.length : close + 1;
      out.push(line.slice(i, end), "tok-string");
      i = end;
      continue;
    }
    if (c === "{" || c === "}") {
      if (c === "{") st.css++;
      else st.css = Math.max(0, st.css - 1);
      st.cssValue = false;
      bracket(out, st, c);
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]") {
      bracket(out, st, c);
      i++;
      continue;
    }
    if (c === ";") {
      st.cssValue = false;
      out.push(c, "tok-punctuation");
      i++;
      continue;
    }
    const at_ = at(/@[\w-]+/y, line, i);
    if (at_) {
      out.push(at_, "tok-control");
      i += at_.length;
      continue;
    }
    const important = at(/!important\b/y, line, i);
    if (important) {
      out.push(important, "tok-control");
      i += important.length;
      continue;
    }
    const scssVar = at(/(?:\$|--)[\w-]+/y, line, i);
    if (scssVar) {
      out.push(scssVar, "tok-variable");
      i += scssVar.length;
      const colon = st.cssValue ? null : at(/\s*:(?!:)/y, line, i);
      if (colon) {
        out.push(colon, "tok-punctuation");
        i += colon.length;
        st.cssValue = true;
      }
      continue;
    }
    if (st.cssValue) {
      const hex = at(/#[\da-fA-F]{3,8}\b/y, line, i);
      if (hex) {
        out.push(hex, "tok-number");
        i += hex.length;
        continue;
      }
      const num = at(/-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, line, i);
      if (num) {
        out.push(num, "tok-number");
        i += num.length;
        continue;
      }
      const word = at(/[A-Za-z_-][\w-]*/y, line, i);
      if (word) {
        out.push(word, line[i + word.length] === "(" ? "tok-function" : "tok-string");
        i += word.length;
        continue;
      }
    } else {
      // A declaration "name:" (not a nested selector like "&:hover {" or "a:hover {").
      const prop = at(/[A-Za-z-][\w-]*(?=\s*:(?!:))/y, line, i);
      if (prop && st.css > 0 && !/\{\s*$/.test(line.slice(i))) {
        out.push(prop, "tok-property");
        i += prop.length;
        const colon = at(/\s*:/y, line, i) ?? ":";
        out.push(colon, "tok-punctuation");
        i += colon.length;
        st.cssValue = true;
        continue;
      }
      const sel = at(/(?:::?|[.#])?[A-Za-z_-][\w-]*/y, line, i) ?? at(/[&*]/y, line, i);
      if (sel) {
        out.push(sel, "tok-selector");
        i += sel.length;
        continue;
      }
    }
    const op = at(/[,>+~:=*/]/y, line, i);
    out.push(op ?? c, op ? "tok-operator" : null);
    i += 1;
  }
}

function scalar(text: string, out: Out): void {
  const t = text.trim();
  if (!t) {
    out.push(text, null);
    return;
  }
  const lead = text.slice(0, text.indexOf(t));
  const tail = text.slice(lead.length + t.length);
  out.push(lead, null);
  if (/^(?:true|false|null|yes|no|on|off|~)$/i.test(t)) out.push(t, "tok-constant");
  else if (/^[-+]?(?:\d[\d_]*\.?\d*(?:e[+-]?\d+)?|0x[\da-f]+|\.inf|\.nan)$/i.test(t)) out.push(t, "tok-number");
  else if (/^["']/.test(t)) out.push(t, "tok-string");
  else if (/^[&*][\w-]+/.test(t)) out.push(t, "tok-variable");
  else if (/^[|>][-+]?$/.test(t)) out.push(t, "tok-operator");
  else if (/^[[{]/.test(t)) {
    // Flow collections: reuse the JSON tokenizer.
    codeLine(t, JSON_G, newState(), out);
  } else out.push(t, "tok-string");
  out.push(tail, null);
}

function splitComment(rest: string): [string, string] {
  // A `#` starts a comment when it begins the value or follows whitespace, outside quotes.
  let quote: string | null = null;
  for (let j = 0; j < rest.length; j++) {
    const c = rest[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (j === 0 || /\s/.test(rest[j - 1]))) return [rest.slice(0, j), rest.slice(j)];
  }
  return [rest, ""];
}

function yamlLine(line: string, out: Out): void {
  if (/^\s*#/.test(line)) {
    out.push(line, "tok-comment");
    return;
  }
  if (/^(?:---|\.\.\.)\s*$/.test(line)) {
    out.push(line, "tok-punctuation");
    return;
  }
  const m = /^(\s*)((?:-\s+)*)((?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?)\s*:)(?=\s|$)/.exec(line);
  let rest = line;
  if (m) {
    out.push(m[1], null);
    out.push(m[2], "tok-punctuation");
    const key = m[3].slice(0, -1);
    out.push(key, "tok-tag");
    out.push(":", "tok-punctuation");
    rest = line.slice(m[0].length);
  } else {
    const dash = /^(\s*)((?:-\s+)*)/.exec(line)!;
    out.push(dash[1], null);
    out.push(dash[2], "tok-punctuation");
    rest = line.slice(dash[0].length);
  }
  const [value, comment] = splitComment(rest);
  scalar(value, out);
  out.push(comment, "tok-comment");
}

function tomlLine(line: string, out: Out): void {
  if (/^\s*[#;]/.test(line)) {
    out.push(line, "tok-comment");
    return;
  }
  const section = /^(\s*)(\[\[?[^\]]*\]\]?)(.*)$/.exec(line);
  if (section) {
    out.push(section[1], null);
    out.push(section[2], "tok-type");
    out.push(section[3], "tok-comment");
    return;
  }
  const kv = /^(\s*)([^=\s][^=]*?)(\s*=\s*)(.*)$/.exec(line);
  if (!kv) {
    out.push(line, null);
    return;
  }
  out.push(kv[1], null);
  out.push(kv[2], "tok-property");
  out.push(kv[3], "tok-operator");
  const [value, comment] = splitComment(kv[4]);
  scalar(value, out);
  out.push(comment, "tok-comment");
}

function markdownInline(text: string, out: Out): void {
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|!?\[[^\]]*\]\([^)]*\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(last, m.index), null);
    const s = m[0];
    if (s.startsWith("`")) out.push(s, "tok-string");
    else if (s.startsWith("**") || s.startsWith("__")) out.push(s, "tok-bold");
    else if (s.startsWith("*") || s.startsWith("_")) out.push(s, "tok-italic");
    else {
      const split = s.indexOf("](");
      out.push(s.slice(0, split + 1), "tok-tag");
      out.push(s.slice(split + 1), "tok-variable");
    }
    last = m.index + s.length;
  }
  out.push(text.slice(last), null);
}

function markdownLine(line: string, st: State, out: Out): void {
  if (/^\s*(```|~~~)/.test(line)) {
    st.block = st.block?.kind === "fence" ? null : { kind: "fence" };
    out.push(line, "tok-comment");
    return;
  }
  if (st.block?.kind === "fence") {
    out.push(line, "tok-string");
    return;
  }
  if (/^#{1,6}\s/.test(line)) {
    out.push(line, "tok-heading");
    return;
  }
  const quote = /^(\s*>+\s?)(.*)$/.exec(line);
  if (quote) {
    out.push(quote[1], "tok-comment");
    markdownInline(quote[2], out);
    return;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    out.push(line, "tok-punctuation");
    return;
  }
  const list = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line);
  if (list) {
    out.push(list[1], null);
    out.push(list[2], "tok-control");
    out.push(list[3], null);
    markdownInline(list[4], out);
    return;
  }
  markdownInline(line, out);
}

function diffLine(line: string, out: Out): void {
  if (line.startsWith("+++") || line.startsWith("---")) out.push(line, "tok-heading");
  else if (line.startsWith("@@")) out.push(line, "tok-hunk");
  else if (line.startsWith("+")) out.push(line, "tok-inserted");
  else if (line.startsWith("-")) out.push(line, "tok-deleted");
  else if (/^(?:diff |index )/.test(line)) out.push(line, "tok-keyword");
  else out.push(line, null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Lines longer than this are left plain: minified bundles would only slow typing down. */
const MAX_LINE = 4000;

function tokenizeLine(line: string, grammar: Grammar, st: State): Token[] {
  const out = new Out();
  if (line.length > MAX_LINE) {
    out.push(line, null);
    return out.tokens;
  }
  switch (grammar.kind) {
    case "code":
      codeLine(line, grammar, st, out);
      break;
    case "markup":
      markupLine(line, st, out);
      break;
    case "css":
      cssLine(line, grammar, st, out);
      break;
    case "yaml":
      yamlLine(line, out);
      break;
    case "toml":
      tomlLine(line, out);
      break;
    case "markdown":
      markdownLine(line, st, out);
      break;
    case "diff":
      diffLine(line, out);
      break;
    default:
      out.push(line, null);
  }
  return out.tokens;
}

/** Tokenize a whole snippet; one token array per line. */
export function tokenize(code: string, lang: string): Token[][] {
  const grammar = GRAMMARS[resolveLang(lang)] ?? GENERIC;
  const st = newState();
  return code.split("\n").map((line) => tokenizeLine(line.replace(/\r$/, ""), grammar, st));
}

/** Per-line results from the previous run, keyed by (state before the line, line text). */
export interface TokenCache {
  lang: string;
  entries: Map<string, { tokens: Token[]; after: State }>;
}

const cloneState = (st: State): State => ({ ...st, block: st.block ? { ...st.block } : null });
const stateKey = (st: State): string =>
  `${st.block ? JSON.stringify(st.block) : ""}|${st.depth}|${st.tag ?? ""}|${st.tagClosing ? 1 : 0}|${st.jsx}|${st.css}|${st.cssValue ? 1 : 0}`;

/**
 * Like `tokenize`, but reuses the previous run's lines when both their text and the state they
 * start in are unchanged — typing re-tokenizes only the edited line (plus any lines whose
 * starting state it changed), which keeps big files responsive.
 */
export function tokenizeIncremental(code: string, lang: string, cache: TokenCache | null): { lines: Token[][]; cache: TokenCache } {
  const grammar = GRAMMARS[resolveLang(lang)] ?? GENERIC;
  const previous = cache && cache.lang === lang ? cache.entries : null;
  const entries = new Map<string, { tokens: Token[]; after: State }>();
  let st = newState();
  const lines = code.split("\n").map((raw) => {
    const line = raw.replace(/\r$/, "");
    const key = `${stateKey(st)}\u0000${line}`;
    const hit = previous?.get(key) ?? entries.get(key);
    if (hit) {
      entries.set(key, hit);
      st = cloneState(hit.after);
      return hit.tokens;
    }
    const tokens = tokenizeLine(line, grammar, st);
    entries.set(key, { tokens, after: cloneState(st) });
    return tokens;
  });
  return { lines, cache: { lang, entries } };
}

/** Tokenize each line on its own (no carried state): for diff rows whose context is partial. */
export function tokenizeLines(lines: readonly string[], lang: string): Token[][] {
  const grammar = GRAMMARS[resolveLang(lang)] ?? GENERIC;
  const st = newState();
  return lines.map((line) => {
    const tokens = tokenizeLine(line, grammar, st);
    // Diff hunks skip lines, so never let an unterminated construct bleed into the next row.
    st.block = null;
    st.tag = null;
    return tokens;
  });
}

export function renderTokens(tokens: readonly Token[]): ReactNode {
  if (tokens.length === 0) return <span> </span>;
  return tokens.map((tok, t) => (tok.cls ? <span key={t} className={tok.cls}>{tok.text}</span> : <span key={t}>{tok.text}</span>));
}

export const HighlightLine = memo(function HighlightLine({ tokens, current }: { tokens: readonly Token[]; current?: boolean }) {
  return <div className={`hl-line${current ? " current" : ""}`}>{renderTokens(tokens)}</div>;
});

export function highlightCode(code: string, lang: string): ReactNode {
  return tokenize(code.replace(/\n$/, ""), lang).map((tokens, idx) => <HighlightLine key={idx} tokens={tokens} />);
}
