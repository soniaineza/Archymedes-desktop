import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AlternativeResult, DecisionState, Sensitivity } from "@shared/enterprise/types";
import type { ForecastRecord, SeriesPoint, StateChange } from "@shared/enterprise/api-types";
import { LIFECYCLE } from "@shared/enterprise/workflow";
import { dateShort, money, pct, STATE_LABEL } from "./client";

/**
 * Hand-built SVG charts. Marks follow one spec: 2px lines, ≤24px bars with a 2px
 * surface gap, hairline solid grids, text in ink tokens (never series color),
 * a hover layer on every plotted mark, and a table/figures alongside.
 */

/** Width of the chart's box; a callback ref, so it attaches whenever the box mounts. */
function useWidth<T extends HTMLElement>(fallback = 560): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="vz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.body}
    </div>
  );
}

const niceStep = (span: number, n = 4) => {
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
};
const ticks = (lo: number, hi: number, n = 4) => {
  const s = niceStep(hi - lo, n);
  const out: number[] = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9; v += s) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
};

// ---------------------------------------------------------------------------
// Trend with projection band
// ---------------------------------------------------------------------------

export function TrendChart({
  series,
  projection,
  bandHalf,
  guide,
  format,
  height = 180,
  label,
}: {
  series: SeriesPoint[];
  projection: SeriesPoint[];
  bandHalf: number;
  guide?: { value: number; label: string };
  format(v: number): string;
  height?: number;
  label: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const pad = { l: 8, r: 64, t: 12, b: 22 };
  const all = [...series, ...projection];
  if (all.length < 2) return <div className="vz-empty">Not enough history to chart.</div>;
  const vals = [...series.map((p) => p.value), ...projection.map((p) => p.value + bandHalf), ...projection.map((p) => p.value - bandHalf), ...(guide ? [guide.value] : [])];
  const lo = Math.min(0, ...vals);
  const hi = Math.max(...vals) * 1.08;
  const n = all.length;
  const x = (i: number) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);
  const line = (pts: SeriesPoint[], off: number) => pts.map((p, i) => `${i ? "L" : "M"}${x(i + off).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const s0 = series.length - 1;
  const projPts = [series[s0], ...projection];
  const band =
    projection.length > 0
      ? `M${x(s0)},${y(series[s0].value)}` +
        projection.map((p, i) => `L${x(s0 + 1 + i)},${y(p.value + bandHalf)}`).join("") +
        [...projection].reverse().map((p, i) => `L${x(n - 1 - i)},${y(p.value - bandHalf)}`).join("") +
        "Z"
      : "";
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (n - 1))));
    const p = all[i];
    const projected = i > s0;
    setTip({
      x: x(i),
      y: y(p.value) - 8,
      body: (
        <>
          <b>{format(p.value)}</b> week of {dateShort(p.t)}
          {projected && <span className="vz-tip-sub">projected · 80% band ±{format(bandHalf)}</span>}
        </>
      ),
    });
  };
  const last = series[s0];
  return (
    <div ref={ref} className="vz" aria-label={label} role="img">
      <svg width={w} height={height}>
        {ticks(lo, hi).map((t) => (
          <g key={t}>
            <line className="vz-grid" x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} />
            <text className="vz-axis" x={w - pad.r + 6} y={y(t) + 3}>
              {format(t)}
            </text>
          </g>
        ))}
        <line className="vz-now" x1={x(s0)} x2={x(s0)} y1={pad.t} y2={height - pad.b} />
        <text className="vz-axis" x={x(s0) + 4} y={height - 6}>
          now
        </text>
        <text className="vz-axis" x={pad.l} y={height - 6}>
          {dateShort(series[0].t)}
        </text>
        {band && <path className="vz-band" d={band} />}
        {guide && (
          <g>
            <line className="vz-guide" x1={pad.l} x2={w - pad.r} y1={y(guide.value)} y2={y(guide.value)} />
            <text className="vz-axis vz-guide-label" x={pad.l + 2} y={y(guide.value) - 4}>
              {guide.label}
            </text>
          </g>
        )}
        <path className="vz-line" d={line(series, 0)} />
        {projection.length > 0 && <path className="vz-line vz-line-proj" d={line(projPts, s0)} />}
        <circle className="vz-dot" cx={x(s0)} cy={y(last.value)} r={4} />
        {tip && <line className="vz-cross" x1={tip.x} x2={tip.x} y1={pad.t} y2={height - pad.b} />}
        <rect x={pad.l} y={0} width={w - pad.l - pad.r} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Goal bullet: baseline → target, actual, forecast band
// ---------------------------------------------------------------------------

export function GoalBullet({ baseline, target, actual, forecast, format, direction }: { baseline: number | null; target: number; actual: number | null; forecast: { value: number; low: number; high: number } | null; format(v: number): string; direction: "increase" | "decrease" }) {
  const [ref, w] = useWidth<HTMLDivElement>(320);
  const vals = [target, baseline ?? 0, actual ?? 0, forecast?.high ?? 0, forecast?.low ?? 0];
  const lo = Math.min(...vals.filter((v) => v !== 0), target) * 0.85;
  const hi = Math.max(...vals) * 1.04;
  const x = (v: number) => 4 + ((v - lo) / (hi - lo || 1)) * (w - 8);
  const H = 46;
  return (
    <div ref={ref} className="vz vz-bullet" role="img" aria-label={`Target ${format(target)}${forecast ? `, forecast ${format(forecast.value)}` : ""}`}>
      <svg width={w} height={H}>
        <rect className="vz-track" x={4} y={14} width={w - 8} height={10} rx={2} />
        {forecast && <rect className="vz-band-solid" x={x(Math.max(lo, forecast.low))} y={14} width={Math.max(2, x(Math.min(hi, forecast.high)) - x(Math.max(lo, forecast.low)))} height={10} />}
        {actual !== null && <rect className="vz-fill" x={4} y={16} width={Math.max(2, x(actual) - 4)} height={6} rx={1} />}
        {baseline !== null && <line className="vz-tick-muted" x1={x(baseline)} x2={x(baseline)} y1={8} y2={30} />}
        <line className="vz-tick" x1={x(target)} x2={x(target)} y1={6} y2={32} />
        {forecast && <circle className="vz-dot-hollow" cx={x(forecast.value)} cy={19} r={4} />}
        <text className="vz-axis" x={Math.min(w - 4, x(target) + 4)} y={42} textAnchor="end">
          target {format(target)} {direction === "decrease" ? "↓" : "↑"}
        </text>
        {baseline !== null && (
          <text className="vz-axis" x={Math.max(4, x(baseline) - 4)} y={6} textAnchor="end">
            baseline
          </text>
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenario columns: width = probability, height = Δcontribution; area = EV
// ---------------------------------------------------------------------------

export function ScenarioChart({ alternatives, currency }: { alternatives: AlternativeResult[]; currency: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const rows = alternatives.filter((a) => !a.isBaseline && a.complete);
  if (!rows.length) return <div className="vz-empty">No complete alternative to chart yet.</div>;
  const all = rows.flatMap((a) => a.scenarios.map((s) => s.deltaContributionMinor));
  const lo = Math.min(0, ...all) * 1.15;
  const hi = Math.max(0, ...all) * 1.15;
  const H = 150;
  const pad = { t: 10, b: 30 };
  const colW = (w - (rows.length - 1) * 24) / rows.length;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  return (
    <div ref={ref} className="vz" role="img" aria-label="Scenario outcomes weighted by probability">
      <svg width={w} height={H}>
        {rows.map((a, ai) => {
          const x0 = ai * (colW + 24);
          let cum = 0;
          return (
            <g key={a.id}>
              <line className="vz-zero" x1={x0} x2={x0 + colW} y1={y(0)} y2={y(0)} />
              {a.scenarios.map((s) => {
                const xs = x0 + cum * colW;
                const ww = Math.max(1, s.probability * colW - 2);
                cum += s.probability;
                const top = Math.min(y(0), y(s.deltaContributionMinor));
                const hh = Math.max(1, Math.abs(y(s.deltaContributionMinor) - y(0)));
                return (
                  <g key={s.key}>
                    <rect
                      className={s.deltaContributionMinor >= 0 ? "vz-pos" : "vz-neg"}
                      x={xs}
                      y={top}
                      width={ww}
                      height={hh}
                      onMouseEnter={() =>
                        setTip({
                          x: xs + ww / 2,
                          y: top - 6,
                          body: (
                            <>
                              <b>{s.label}</b> · p {pct(s.probability)}
                              <span className="vz-tip-sub">
                                Δ contribution {money(s.deltaContributionMinor, currency, { signed: true })} · Δ revenue {money(s.deltaRevenueMinor, currency, { signed: true })}
                              </span>
                            </>
                          ),
                        })
                      }
                      onMouseLeave={() => setTip(null)}
                    />
                    <text className="vz-axis" x={xs + 2} y={H - 16}>
                      {s.label} {pct(s.probability)}
                    </text>
                  </g>
                );
              })}
              {a.evContributionMinor !== null && (
                <g>
                  <line className="vz-ev" x1={x0} x2={x0 + colW - 2} y1={y(a.evContributionMinor)} y2={y(a.evContributionMinor)} />
                  <text className="vz-ev-label" x={x0 + colW - 4} y={y(a.evContributionMinor) - 4} textAnchor="end">
                    EV {money(a.evContributionMinor, currency)}
                  </text>
                </g>
              )}
              <text className="vz-title" x={x0} y={H - 2}>
                {a.name}
              </text>
            </g>
          );
        })}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Range strip (min … EV … max) on a shared scale
// ---------------------------------------------------------------------------

export function RangeStrip({ min, max, ev, lo, hi, currency }: { min: number; max: number; ev: number; lo: number; hi: number; currency: string }) {
  const W = 160;
  const x = (v: number) => 4 + ((v - lo) / (hi - lo || 1)) * (W - 8);
  return (
    <svg width={W} height={18} className="vz-inline" role="img" aria-label={`Range ${money(min, currency)} to ${money(max, currency)}, expected ${money(ev, currency)}`}>
      <title>{`${money(min, currency)} … ${money(max, currency)} · EV ${money(ev, currency)}`}</title>
      <line className="vz-zero" x1={x(0)} x2={x(0)} y1={2} y2={16} />
      <line className="vz-range" x1={x(min)} x2={x(max)} y1={9} y2={9} />
      <circle className="vz-dot" cx={x(ev)} cy={9} r={4} />
    </svg>
  );
}

export function Meter({ value, limit, label }: { value: number; limit?: number; label: string }) {
  const W = 120;
  const over = limit !== undefined && value > limit;
  return (
    <span className="vz-meter-wrap">
      <svg width={W} height={10} className="vz-inline" role="img" aria-label={`${label} ${pct(value)}${limit !== undefined ? `, limit ${pct(limit)}` : ""}`}>
        <rect className="vz-track" x={0} y={2} width={W} height={6} rx={3} />
        <rect className={over ? "vz-neg" : "vz-fill"} x={0} y={2} width={Math.max(3, value * W)} height={6} rx={3} />
        {limit !== undefined && <line className="vz-tick" x1={limit * W} x2={limit * W} y1={0} y2={10} />}
      </svg>
      <span className="vz-meter-num">{pct(value)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sensitivity tornado
// ---------------------------------------------------------------------------

export function Tornado({ items, ev, runnerUp, currency }: { items: Sensitivity[]; ev: number; runnerUp: number; currency: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  if (!items.length) return null;
  const labelW = Math.min(240, w * 0.42);
  const lo = Math.min(runnerUp, ...items.map((s) => s.lowMinor)) * 1.1 - 1;
  const hi = Math.max(ev, ...items.map((s) => s.highMinor)) * 1.05 + 1;
  const x = (v: number) => labelW + ((v - Math.min(0, lo)) / (hi - Math.min(0, lo) || 1)) * (w - labelW - 12);
  const rowH = 30;
  const H = items.length * rowH + 26;
  return (
    <div ref={ref} className="vz" role="img" aria-label="Sensitivity of expected contribution">
      <svg width={w} height={H}>
        <line className="vz-ev" x1={x(ev)} x2={x(ev)} y1={4} y2={H - 18} />
        <text className="vz-ev-label" x={x(ev) + 4} y={H - 6}>
          EV {money(ev, currency)}
        </text>
        <line className="vz-guide" x1={x(runnerUp)} x2={x(runnerUp)} y1={4} y2={H - 18} />
        <text className="vz-axis" x={x(runnerUp) - 4} y={H - 6} textAnchor="end">
          next best {money(runnerUp, currency)}
        </text>
        {items.map((s, i) => {
          const yy = 8 + i * rowH;
          return (
            <g key={s.key}>
              <text className="vz-label" x={0} y={yy + 13}>
                {s.label}
              </text>
              <rect
                className={s.flipsRanking ? "vz-neg" : "vz-pos"}
                x={x(s.lowMinor)}
                y={yy + 2}
                width={Math.max(2, x(s.highMinor) - x(s.lowMinor))}
                height={16}
                rx={2}
                onMouseEnter={() => setTip({ x: x((s.lowMinor + s.highMinor) / 2), y: yy, body: <><b>{s.label}</b><span className="vz-tip-sub">EV {money(s.lowMinor, currency)} … {money(s.highMinor, currency)}{s.flipsRanking ? " · can flip the ranking" : ""}</span></> })}
                onMouseLeave={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle rail
// ---------------------------------------------------------------------------

export function LifecycleRail({ state, history }: { state: DecisionState; history: StateChange[] }) {
  const offPath = !LIFECYCLE.includes(state);
  const idx = offPath ? -1 : LIFECYCLE.indexOf(state);
  const when = (s: DecisionState) => [...history].reverse().find((h) => h.state === s)?.at;
  return (
    <ol className="vz-rail" aria-label="Decision lifecycle">
      {LIFECYCLE.map((s, i) => {
        const current = s === state;
        const done = i < idx;
        return (
          <li key={s} className={current ? "is-current" : done ? "is-done" : ""} {...(current ? { "data-testid": "lifecycle-current", "aria-current": "step" as const } : {})}>
            <span className="vz-rail-dot" aria-hidden />
            <span className="vz-rail-label">{STATE_LABEL[s]}</span>
            <span className="vz-rail-at">{when(s) ? dateShort(when(s)!) : ""}</span>
          </li>
        );
      })}
      {offPath && (
        <li className="is-current is-off" data-testid="lifecycle-current" aria-current="step">
          <span className="vz-rail-dot" aria-hidden />
          <span className="vz-rail-label">{STATE_LABEL[state]}</span>
          <span className="vz-rail-at">{when(state) ? dateShort(when(state)!) : ""}</span>
        </li>
      )}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Calibration: reliability diagram
// ---------------------------------------------------------------------------

export function Calibration({ points }: { points: ForecastRecord[] }) {
  const [ref, w0] = useWidth<HTMLDivElement>(260);
  const [tip, setTip] = useState<Tip | null>(null);
  const S = Math.min(w0, 300);
  const pad = 28;
  const x = (p: number) => pad + p * (S - pad - 8);
  const y = (p: number) => 8 + (1 - p) * (S - pad - 8);
  const bins = [0, 0.2, 0.4, 0.6, 0.8].map((b) => {
    const inBin = points.filter((pt) => pt.p >= b && (pt.p < b + 0.2 || (b === 0.8 && pt.p <= 1)));
    return inBin.length ? { p: inBin.reduce((s, q) => s + q.p, 0) / inBin.length, freq: inBin.reduce((s, q) => s + q.outcome, 0) / inBin.length, n: inBin.length } : null;
  });
  return (
    <div ref={ref} className="vz" role="img" aria-label="Forecast calibration">
      <svg width={S} height={S}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line className="vz-grid" x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} />
            <text className="vz-axis" x={2} y={y(t) + 3}>
              {pct(t)}
            </text>
            <text className="vz-axis" x={x(t)} y={S - 8} textAnchor="middle">
              {pct(t)}
            </text>
          </g>
        ))}
        <line className="vz-guide" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
        {points.map((pt, i) => (
          <circle
            key={pt.id}
            className="vz-dot-muted"
            cx={x(pt.p)}
            cy={y(pt.outcome) + (pt.outcome ? 6 : -6) + ((i % 3) - 1) * 3}
            r={4}
            onMouseEnter={() => setTip({ x: x(pt.p), y: y(pt.outcome) - 10, body: <><b>{pt.decisionTitle}</b><span className="vz-tip-sub">forecast {pct(pt.p)} · {pt.outcome ? "goal met" : "missed"}</span></> })}
            onMouseLeave={() => setTip(null)}
          />
        ))}
        <path className="vz-line" d={bins.filter(Boolean).map((b, i) => `${i ? "L" : "M"}${x(b!.p)},${y(b!.freq)}`).join("")} />
        {bins.filter(Boolean).map((b) => (
          <circle key={b!.p} className="vz-dot" cx={x(b!.p)} cy={y(b!.freq)} r={4} />
        ))}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Predicted vs measured (forest)
// ---------------------------------------------------------------------------

export function PredictedVsMeasured({ rows, currency }: { rows: { label: string; predicted: { ev: number | null; min?: number; max?: number }; measured: { value: number; low: number | null; high: number | null } }[]; currency: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  if (!rows.length) return null;
  const vals = rows.flatMap((r) => [r.predicted.ev ?? 0, r.predicted.min ?? 0, r.predicted.max ?? 0, r.measured.value, r.measured.low ?? r.measured.value, r.measured.high ?? r.measured.value, 0]);
  const lo = Math.min(...vals) * 1.1;
  const hi = Math.max(...vals) * 1.1;
  const labelW = Math.min(220, w * 0.38);
  const x = (v: number) => labelW + ((v - lo) / (hi - lo || 1)) * (w - labelW - 10);
  const rowH = 42;
  const H = rows.length * rowH + 24;
  return (
    <div ref={ref} className="vz" role="img" aria-label="Predicted against measured incremental revenue">
      <svg width={w} height={H}>
        <line className="vz-zero" x1={x(0)} x2={x(0)} y1={0} y2={H - 18} />
        {ticks(lo, hi, 4).map((t) => (
          <text key={t} className="vz-axis" x={x(t)} y={H - 4} textAnchor="middle">
            {money(Math.round(t), currency, { compact: true })}
          </text>
        ))}
        {rows.map((r, i) => {
          const yy = 6 + i * rowH;
          return (
            <g key={r.label + i}>
              <text className="vz-label" x={0} y={yy + 18}>
                {r.label}
              </text>
              {r.predicted.ev !== null && (
                <g onMouseEnter={() => setTip({ x: x(r.predicted.ev!), y: yy, body: <><b>Predicted</b> EV {money(r.predicted.ev, currency)}</> })} onMouseLeave={() => setTip(null)}>
                  {r.predicted.min !== undefined && <line className="vz-range-muted" x1={x(r.predicted.min)} x2={x(r.predicted.max!)} y1={yy + 8} y2={yy + 8} />}
                  <circle className="vz-dot-hollow" cx={x(r.predicted.ev)} cy={yy + 8} r={5} />
                </g>
              )}
              <g onMouseEnter={() => setTip({ x: x(r.measured.value), y: yy + 16, body: <><b>Measured</b> {money(r.measured.value, currency)}{r.measured.low !== null && <span className="vz-tip-sub">95% CI {money(r.measured.low, currency)} … {money(r.measured.high, currency)}</span>}</> })} onMouseLeave={() => setTip(null)}>
                {r.measured.low !== null && <line className="vz-range" x1={x(r.measured.low)} x2={x(r.measured.high!)} y1={yy + 24} y2={yy + 24} />}
                <circle className="vz-dot" cx={x(r.measured.value)} cy={yy + 24} r={5} />
              </g>
            </g>
          );
        })}
      </svg>
      <div className="vz-legend">
        <span>
          <i className="lg-hollow" /> Predicted (EV, scenario range)
        </span>
        <span>
          <i className="lg-dot" /> Measured (95% CI)
        </span>
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

/** Segmented bar: moat value by stage. */
export function StageBar({ parts, currency }: { parts: { label: string; value: number; tone: string }[]; currency: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div className="vz-stagebar" role="img" aria-label={parts.map((p) => `${p.label} ${money(p.value, currency)}`).join(", ")}>
      <div className="vz-stagebar-track">
        {parts.map((p) => (
          <span key={p.label} className={`vz-seg ${p.tone}`} style={{ flexGrow: Math.max(p.value / total, 0.02) }} title={`${p.label}: ${money(p.value, currency)}`} />
        ))}
      </div>
      <div className="vz-legend">
        {parts.map((p) => (
          <span key={p.label}>
            <i className={`lg-sq ${p.tone}`} /> {p.label} <b>{money(p.value, currency, { compact: true })}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
