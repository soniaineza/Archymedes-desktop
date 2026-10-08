/**
 * Tool-call arguments as a JSON object, repaired when a model sends almost-JSON. Free and small
 * models often emit trailing commas, single-quoted strings, code-fenced JSON, a JSON string that
 * holds the object, unquoted keys, raw newlines inside strings, or a truncated object missing its
 * closing braces. Each is fixed here before the call is rejected; valid JSON passes through as is.
 */

export type ArgsRepair = { ok: true; json: string; repaired: boolean } | { ok: false };

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `{"name": "read_file", "arguments": {...}}`: a model that wrapped the call itself. */
function unwrap(object: Json): Json {
  const keys = Object.keys(object);
  const wrapperKeys = new Set(["name", "arguments", "parameters", "type", "id"]);
  if (!keys.every((key) => wrapperKeys.has(key)) || typeof object.name !== "string") return object;
  const inner = object.arguments ?? object.parameters;
  const parsed = typeof inner === "string" ? asObject(tryParse(inner)) : asObject(inner);
  return parsed ?? object;
}

/** A parsed value as the object a tool takes, following one level of string encoding. */
function objectFrom(value: unknown): { object: Json; nested: boolean } | undefined {
  const direct = asObject(value);
  if (direct) return { object: direct, nested: false };
  if (typeof value === "string") {
    const inner = asObject(tryParse(value.trim()));
    if (inner) return { object: inner, nested: true };
  }
  return undefined;
}

const CLOSERS: Record<string, string> = { "{": "}", "[": "]" };
const BARE_WORDS: Record<string, string> = {
  true: "true",
  false: "false",
  null: "null",
  True: "true",
  False: "false",
  None: "null",
};

/**
 * One pass over almost-JSON: single-quoted strings become double-quoted, raw control characters in
 * strings are escaped, bare keys are quoted, Python literals are lowered, trailing commas go, and
 * unclosed objects and arrays are closed in order. An unterminated string is not guessed at: it
 * usually means the output was cut off, and closing it would write half a file.
 */
export function normalizeJsonish(text: string): string | undefined {
  let out = "";
  const stack: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '"';
      let closed = false;
      i += 1;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          const next = text[i + 1];
          if (next === undefined) {
            i += 1;
            break;
          }
          // JSON has no \' escape; a quote needs none inside a double-quoted string.
          value += next === "'" ? "'" : c + next;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        if (c === '"') value += '\\"';
        else if (c === "\n") value += "\\n";
        else if (c === "\r") value += "\\r";
        else if (c === "\t") value += "\\t";
        else value += c;
        i += 1;
      }
      if (!closed) return undefined;
      out += value + '"';
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(CLOSERS[ch]);
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      out = out.replace(/,\s*$/, "");
      if (stack[stack.length - 1] === ch) stack.pop();
      out += ch;
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (text[k] === ":") out += JSON.stringify(word);
      else out += BARE_WORDS[word] ?? word;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  out = out.replace(/[,:]\s*$/, "");
  while (stack.length > 0) {
    out = out.replace(/,\s*$/, "");
    out += stack.pop();
  }
  return out;
}

/** The object inside fences or surrounding prose, from the first `{` to its last `}` (or the end). */
function extractObject(text: string): string {
  const fenced = /```[a-zA-Z]*\s*([\s\S]*?)(?:```|$)/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start === -1) return body.trim();
  const end = body.lastIndexOf("}");
  return (end > start ? body.slice(start, end + 1) : body.slice(start)).trim();
}

export function repairToolArgs(raw: string): ArgsRepair {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, json: "{}", repaired: raw !== "" && raw !== undefined };

  const direct = tryParse(text);
  const found = objectFrom(direct);
  if (found) {
    const object = unwrap(found.object);
    if (!found.nested && object === found.object) return { ok: true, json: raw, repaired: false };
    return { ok: true, json: JSON.stringify(object), repaired: true };
  }

  const candidates = [extractObject(text), text];
  for (const candidate of candidates) {
    for (const attempt of [candidate, normalizeJsonish(candidate)]) {
      if (attempt === undefined) continue;
      const result = objectFrom(tryParse(attempt));
      if (result) return { ok: true, json: JSON.stringify(unwrap(result.object)), repaired: true };
    }
  }
  return { ok: false };
}
