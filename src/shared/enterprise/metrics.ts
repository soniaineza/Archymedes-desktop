import type { MetricCalc, MetricFilter, MetricValue, SourceRow } from "./types";

export function ratio(numerator: number, denominator: number): MetricValue {
  if (denominator === 0) return { kind: "unknown", reason: "zero denominator: no qualifying records in the period" };
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return { kind: "unknown", reason: "non-finite input" };
  return { kind: "value", value: numerator / denominator };
}

function matches(row: SourceRow, filters: MetricFilter[]): boolean {
  return filters.every((f) => row.fields[f.field] === f.equals);
}

function inWindow(row: SourceRow, window: { start: string; end: string }): boolean {
  const t = Date.parse(row.occurredAt);
  return t >= Date.parse(window.start) && t < Date.parse(window.end);
}

function aggregate(part: { kind: "sum" | "count"; field?: string; filters: MetricFilter[] }, rows: SourceRow[]): MetricValue {
  const selected = rows.filter((r) => matches(r, part.filters));
  if (part.kind === "count") return { kind: "value", value: selected.length };
  const currencies = new Set(selected.map((r) => r.currency));
  if (currencies.size > 1) return { kind: "unknown", reason: `mixed currencies (${[...currencies].join(", ")}): convert before summing` };
  return { kind: "value", value: selected.reduce((s, r) => s + (part.field === "amount" || part.field === undefined ? r.amountMinor : Number(r.fields[part.field] ?? 0)), 0) };
}

/** Computes a metric over [start, end). Ratios with an empty denominator are unknown. */
export function computeMetric(calc: MetricCalc, rows: SourceRow[], window: { start: string; end: string }): MetricValue {
  const scoped = rows.filter((r) => inWindow(r, window));
  if (calc.kind !== "ratio") return aggregate(calc, scoped);
  const n = aggregate(calc.numerator, scoped);
  const d = aggregate(calc.denominator, scoped);
  if (n.kind === "unknown") return n;
  if (d.kind === "unknown") return d;
  return ratio(n.value, d.value);
}

export interface Freshness {
  state: "fresh" | "stale" | "never";
  ageHours: number | null;
}

export function freshness(lastSyncAt: string | null, now: string, thresholdHours: number): Freshness {
  if (!lastSyncAt) return { state: "never", ageHours: null };
  const ageHours = Math.round(((Date.parse(now) - Date.parse(lastSyncAt)) / 3_600_000) * 10) / 10;
  return { state: ageHours <= thresholdHours ? "fresh" : "stale", ageHours };
}
