import type { ReactNode } from "react";

/**
 * A tiny, dependency-free syntax highlighter for the languages you actually
 * see in this app: TS/JS/TSX, JSON, CSS, Markdown, plus generic handling for
 * everything else (strings, comments, numbers, keywords).
 *
 * Output is plain colored spans — no external highlighter dependency.
 */

type Token = { text: string; cls: string | null };

const KEYWORDS = new Set([
  // JS/TS
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "new", "delete", "typeof",
  "instanceof", "in", "of", "class", "extends", "implements", "interface",
  "type", "enum", "import", "export", "from", "as", "default", "async",
  "await", "try", "catch", "finally", "throw", "yield", "this", "super",
  "static", "public", "private", "protected", "readonly", "abstract",
  "declare", "namespace", "void", "null", "undefined", "true", "false",
  "never", "unknown", "any", "string", "number", "boolean", "object",
  // Rust
  "fn", "let", "mut", "pub", "struct", "impl", "trait", "match", "Some",
  "None", "Ok", "Err", "crate", "use", "mod", "self",
  // Python
  "def", "elif", "lambda", "pass", "with", "not", "and", "or", "is",
  "None", "True", "False", "import", "from", "global", "nonlocal",
]);

function tokenizeLine(line: string, lang: string, inBlockComment: boolean): { tokens: Token[]; inBlockComment: boolean } {
  const tokens: Token[] = [];
  let i = 0;
  let comment = inBlockComment;

  const push = (text: string, cls: string | null) => {
    if (text) tokens.push({ text, cls });
  };

  while (i < line.length) {
    if (comment) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        push(line.slice(i), "tok-comment");
        i = line.length;
      } else {
        push(line.slice(i, end + 2), "tok-comment");
        i = end + 2;
        comment = false;
      }
      continue;
    }

    const rest = line.slice(i);

    // block comment start
    if (rest.startsWith("/*")) {
      push("/*", "tok-comment");
      i += 2;
      comment = true;
      continue;
    }
    // line comments
    const lineComment = lang === "python" ? (rest.startsWith("#") ? "#" : null) : rest.startsWith("//") ? "//" : null;
    if (lineComment) {
      push(line.slice(i), "tok-comment");
      i = line.length;
      continue;
    }
    // strings (incl. template literals)
    const strMatch = /^(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(rest);
    if (strMatch) {
      const isTemplate = strMatch[0].startsWith("`");
      push(strMatch[0], isTemplate ? "tok-template" : "tok-string");
      i += strMatch[0].length;
      continue;
    }
    // numbers
    const numMatch = /^(0x[\da-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)/.exec(rest);
    if (numMatch) {
      push(numMatch[0], "tok-number");
      i += numMatch[0].length;
      continue;
    }
    // identifiers / keywords
    const idMatch = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (idMatch) {
      const word = idMatch[0];
      const after = rest.slice(word.length);
      if (KEYWORDS.has(word)) {
        push(word, "tok-keyword");
      } else if (/^\s*\(/.test(after)) {
        push(word, "tok-fn");
      } else if (/^[A-Z]/.test(word)) {
        push(word, "tok-type");
      } else {
        push(word, null);
      }
      i += word.length;
      continue;
    }
    // JSX tags heuristic: <Component
    if (lang === "tsx" && rest.startsWith("<")) {
      push("<", "tok-punct");
      i += 1;
      continue;
    }
    // punctuation
    push(rest[0], "tok-punct");
    i += 1;
  }

  return { tokens, inBlockComment: comment };
}

export function highlightCode(code: string, lang: string): ReactNode {
  const isBlock = ["css", "scss"].includes(lang);
  const lines = code.replace(/\n$/, "").split("\n");
  let inBlockComment = false;

  return lines.map((line, idx) => {
    const { tokens, inBlockComment: next } = tokenizeLine(line, lang, inBlockComment);
    inBlockComment = next;
    return (
      <div key={idx} className="hl-line">
        {tokens.map((tok, t) =>
          tok.cls ? (
            <span key={t} className={tok.cls}>{tok.text}</span>
          ) : (
            <span key={t}>{tok.text}</span>
          ),
        )}
        {tokens.length === 0 && <span> </span>}
        {idx === lines.length - 1 && isBlock && null}
      </div>
    );
  });
}
