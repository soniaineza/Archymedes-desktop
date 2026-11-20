import { isCurrencyCode, minorDigits, parseMoneyToMinor } from "./money";
import type { ImportIssue, ImportMapping, ImportPreview } from "./types";

/** RFC-4180-style CSV: quoted fields, embedded commas/newlines, "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function parseDate(text: string): string | null {
  const t = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const ms = Date.parse(/T/.test(t) ? t : `${t}T00:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Maps a CSV into source rows and reports every row it will not import, with
 * its 1-based file line. `existing` holds external IDs this tenant already has,
 * so a replayed file imports nothing twice.
 */
export function previewImport(csv: string, mapping: ImportMapping, existing: ReadonlySet<string>, companyCurrency?: string): ImportPreview {
  const [header = [], ...body] = parseCsv(csv);
  const preview: ImportPreview = { header, rows: [], duplicates: [], missing: [], invalid: [] };
  const col = new Map(header.map((h, i) => [h.trim(), i]));
  const required = [mapping.externalId, mapping.occurredAt, mapping.amount, ...(mapping.currency ? [mapping.currency] : []), ...Object.values(mapping.extra)];
  const absent = required.filter((c) => !col.has(c));
  if (absent.length) {
    preview.invalid.push({ line: 1, reason: `mapped column(s) not in file: ${absent.join(", ")}` });
    return preview;
  }
  const seen = new Set(existing);
  body.forEach((cells, idx) => {
    const line = idx + 2;
    const at = (c: string) => (cells[col.get(c)!] ?? "").trim();
    const issue = (list: ImportIssue[], reason: string) => list.push({ line, reason });
    const id = at(mapping.externalId);
    const date = at(mapping.occurredAt);
    const amount = at(mapping.amount);
    const empty = [!id && mapping.externalId, !date && mapping.occurredAt, !amount && mapping.amount].filter(Boolean);
    if (empty.length) return issue(preview.missing, `empty: ${empty.join(", ")}`);
    if (seen.has(id)) return issue(preview.duplicates, `${id} already imported`);
    const currency = (mapping.currency ? at(mapping.currency) : "") || mapping.defaultCurrency;
    if (!isCurrencyCode(currency)) return issue(preview.invalid, `currency "${currency}" is not a code like USD`);
    if (companyCurrency && currency !== companyCurrency) return issue(preview.invalid, `currency ${currency} differs from company currency ${companyCurrency}`);
    const occurredAt = parseDate(date);
    if (!occurredAt) return issue(preview.invalid, `date "${date}" is not YYYY-MM-DD`);
    const amountMinor = parseMoneyToMinor(amount, minorDigits(currency));
    if (amountMinor === null) return issue(preview.invalid, `amount "${amount}" is not a number`);
    seen.add(id);
    const fields: Record<string, string> = {};
    for (const [name, column] of Object.entries(mapping.extra)) fields[name] = at(column);
    preview.rows.push({ externalId: id, occurredAt, currency, amountMinor, fields });
  });
  return preview;
}
