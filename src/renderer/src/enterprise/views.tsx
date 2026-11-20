import { useMemo, useState } from "react";
import type {
  AuditEvent,
  DecisionSummary,
  KpiCard,
  Member,
  MetricDefinition,
  MoatAsset,
  Objective,
  Outcome,
  OutboxAction,
  PolicyVersion,
  StoredRow,
  TodayView,
  WorkView,
} from "@shared/enterprise/api-types";
import type { ImportPreview } from "@shared/enterprise/types";
import { annualPlanAlternative, baselineAlternative, leadFollowUpAlternative } from "@shared/enterprise/fixtures";
import { ago, date, EntCallError, metricValue, money, pct, roleLabel, sha256Hex, STATE_LABEL, stateTone, useEnt, useGet } from "./client";
import { Btn, Chip, Empty, ErrorLine, Facts, Field, Figure, PageHead, SectionHead, SlidePanel } from "./ui";
import { Calibration, GoalBullet, PredictedVsMeasured, StageBar, TrendChart } from "./viz";

type Open = (decisionId: string) => void;

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EntCallError | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof EntCallError ? e : new EntCallError(0, "error", String(e)));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function freshTone(k: KpiCard): "good" | "warn" | "bad" {
  return k.freshness.state === "fresh" ? "good" : k.freshness.state === "stale" ? "warn" : "bad";
}
function freshLabel(k: KpiCard): string {
  return k.freshness.state === "never" ? "no source" : k.freshness.state === "fresh" ? `fresh · ${k.freshness.ageHours} h` : `stale · ${k.freshness.ageHours} h`;
}

// ===========================================================================
// Today
// ===========================================================================

export function TodayPage({ onOpen, onExplain }: { onOpen: Open; onExplain(k: KpiCard): void }) {
  const { data, error } = useGet<TodayView>("/today");
  const { me } = useEnt();
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="sx-loading">Loading…</div>;
  const cur = data.profile.currency;
  const hello = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  return (
    <>
      <PageHead
        index="01"
        title="Today"
        kicker={
          <>
            {hello}, {me.name.split(" ")[0]}. {data.attention.length} decision{data.attention.length === 1 ? "" : "s"} need you · {data.work.length} open work item{data.work.length === 1 ? "" : "s"}.
          </>
        }
        aside={<span className="sx-date">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>}
      />

      <div className="sx-kpis">
        {data.kpis.map((k) => (
          <article key={k.objectiveId} className="sx-kpi">
            <header>
              <span className="sx-kpi-name">{k.name}</span>
              <Chip tone={k.status === "draft" ? "warn" : freshTone(k)}>{k.status === "draft" ? "draft goal" : freshLabel(k)}</Chip>
            </header>
            <button type="button" className="sx-kpi-value" onClick={() => onExplain(k)} title="Definition and provenance">
              {metricValue(k.actual, k.unit, cur, true)}
              <span className="sx-kpi-unit">{k.unit === "money" ? "last 13 wks" : "latest week"}</span>
            </button>
            <GoalBullet baseline={k.baseline?.value ?? null} target={k.target.value} actual={k.actual} forecast={k.forecast} format={(v) => metricValue(v, k.unit, cur, true)} direction={k.direction} />
            <footer>
              <span>
                Forecast <b>{metricValue(k.forecast?.value ?? null, k.unit, cur, true)}</b>
              </span>
              <span>
                P(hit) <b>{pct(k.forecast?.pHit ?? null)}</b>
              </span>
            </footer>
          </article>
        ))}
      </div>

      <div className="sx-cols">
        <section className="sx-col sx-col-wide" aria-labelledby="att-h">
          <SectionHead index="1.1" title="Decisions needing attention" id="att-h" />
          {data.attention.length === 0 ? <Empty>Nothing waits on you.</Empty> : <DecisionList items={data.attention} onOpen={onOpen} currency={cur} />}

          <section aria-labelledby="work-h">
            <SectionHead index="1.2" title={me.role === "operator" ? "Your work" : "Work in flight"} id="work-h" />
            {data.work.length === 0 ? <Empty>No open work.</Empty> : <WorkList items={data.work} onOpen={onOpen} />}
          </section>

          <section aria-labelledby="out-h">
            <SectionHead index="1.3" title="Changes in outcomes" id="out-h" />
            {data.outcomes.length === 0 ? (
              <Empty>No measured outcomes yet.</Empty>
            ) : (
              <ul className="sx-rows">
                {data.outcomes.slice(0, 4).map((o) => (
                  <li key={o.id}>
                    <button type="button" className="sx-row" onClick={() => onOpen(o.decisionId)}>
                      <span className="sx-row-main">
                        <b>{o.decisionTitle}</b>
                        <span className="sx-muted">{o.measurement.confidenceLabel}</span>
                      </span>
                      <span className="sx-row-num">{money(o.measurement.incrementalTotalMinor, cur, { signed: true })}</span>
                      <Chip tone={o.status === "verified" ? "good" : o.status === "disputed" ? "bad" : "warn"}>{o.status.replace("_", " ")}</Chip>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>

        <aside className="sx-col">
          <SectionHead index="1.4" title="Blockers" />
          {data.blockers.length ? (
            <ul className="sx-bullets">
              {data.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <Empty>No blockers.</Empty>
          )}
          <SectionHead index="1.5" title="Orion calibration" />
          <div className="sx-grid sx-grid-2">
            <Figure label="Brier score" value={data.calibration.score === null ? "—" : data.calibration.score.toFixed(3)} sub={`n = ${data.calibration.n} · lower is better`} />
            <Figure label="Skill vs base rate" value={data.calibration.skill === null ? "—" : `${data.calibration.skill >= 0 ? "+" : ""}${(data.calibration.skill * 100).toFixed(0)}%`} sub={`base rate ${data.calibration.baseline?.toFixed(3) ?? "—"}`} />
          </div>
          <SectionHead index="1.6" title="Defensibility" />
          <StageBar
            currency={cur}
            parts={[
              { label: "Expected (proposed/created)", value: data.moat.proposedMinor, tone: "seg-muted" },
              { label: "Verified", value: data.moat.verifiedMinor, tone: "seg-mid" },
              { label: "Realized", value: data.moat.realizedMinor, tone: "seg-accent" },
            ]}
          />
        </aside>
      </div>
    </>
  );
}

export function DecisionList({ items, onOpen, currency }: { items: DecisionSummary[]; onOpen: Open; currency: string }) {
  return (
    <ul className="sx-rows">
      {items.map((d) => (
        <li key={d.id}>
          <button type="button" className="sx-row" onClick={() => onOpen(d.id)}>
            <span className="sx-row-main">
              <b>{d.title}</b>
              <span className="sx-muted">
                {d.why} · {d.ownerName}
                {d.recommendedName ? ` · ${d.recommendedName}` : ""}
              </span>
            </span>
            <span className="sx-row-num">
              {money(d.evContributionMinor, currency)}
              <small>{d.pGoal !== null ? `P(goal) ${pct(d.pGoal)}` : ""}</small>
            </span>
            <Chip tone={stateTone(d.state)}>{STATE_LABEL[d.state]}</Chip>
          </button>
        </li>
      ))}
    </ul>
  );
}

function WorkList({ items, onOpen }: { items: WorkView[]; onOpen: Open }) {
  return (
    <ul className="sx-rows">
      {items.map((w) => (
        <li key={w.id}>
          <button type="button" className="sx-row" onClick={() => onOpen(w.decisionId)}>
            <span className="sx-row-main">
              <b>{w.title}</b>
              <span className="sx-muted">
                {w.compassTaskId ?? "sync pending"} · {w.assigneeName} · {w.decisionTitle}
              </span>
            </span>
            <Chip tone={w.state === "linked" ? "accent" : w.state === "in_review" ? "warn" : w.state === "sync_failed" ? "bad" : "neutral"}>{w.state.replace("_", " ")}</Chip>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ===========================================================================
// Provenance panel
// ===========================================================================

export function ProvenancePanel({ kpi, onClose }: { kpi: KpiCard; onClose(): void }) {
  const { data } = useGet<{ metrics: MetricDefinition[] }>("/metrics");
  const rows = useGet<{ total: number; rows: StoredRow[]; imports: { id: string; source: string; createdAt: string; imported: number }[] }>("/source-rows");
  const { currency } = { currency: kpi.currency };
  const def = data?.metrics.find((m) => m.name === kpi.metricName);
  return (
    <SlidePanel title={kpi.metricName} kicker={`Definition and provenance · v${kpi.metricVersion}`} onClose={onClose}>
      <p className="dp-hyp">{kpi.definition}</p>
      <Facts
        rows={[
          ["Goal", kpi.name],
          ["Unit", kpi.unit],
          ["Calculation", <code key="c">{def ? JSON.stringify(def.calc) : "…"}</code>],
          ["Grain", def?.grain ?? "…"],
          ["Source", kpi.source],
          ["Freshness", `${freshLabel(kpi)} · threshold ${def?.freshnessHours ?? "…"} h`],
          ["Owner", kpi.ownerName ?? "unassigned"],
          ["Baseline", kpi.baseline ? `${metricValue(kpi.baseline.value, kpi.unit, currency)} (${kpi.baseline.label})` : "not set"],
          ["Target", `${metricValue(kpi.target.value, kpi.unit, currency)} by ${date(kpi.target.deadline)}`],
          ["Forecast", kpi.forecast ? `${metricValue(kpi.forecast.value, kpi.unit, currency)} · 80% band ${metricValue(kpi.forecast.low, kpi.unit, currency, true)} … ${metricValue(kpi.forecast.high, kpi.unit, currency, true)} · P(hit) ${pct(kpi.forecast.pHit)}` : "insufficient data"],
          ["Method", "OLS trend on weekly observations, normal residuals — a planning aid, not a causal claim"],
        ]}
      />
      <SectionHead title="Latest source rows" aside={<span className="sx-muted">{rows.data?.total ?? 0} rows total</span>} />
      <div className="sx-table-wrap">
        <table className="sx-table sx-table-tight">
          <thead>
            <tr>
              <th>External ID</th>
              <th>Date</th>
              <th className="num">Amount</th>
              <th>Fields</th>
            </tr>
          </thead>
          <tbody>
            {(rows.data?.rows ?? []).slice(-12).reverse().map((r) => (
              <tr key={r.id}>
                <td>
                  <code>{r.externalId}</code>
                </td>
                <td>{date(r.occurredAt)}</td>
                <td className="num">{money(r.amountMinor, r.currency)}</td>
                <td className="sx-muted">{Object.entries(r.fields).map(([k, v]) => `${k}=${v}`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SlidePanel>
  );
}

// ===========================================================================
// Goals
// ===========================================================================

export function GoalsPage({ onExplain }: { onExplain(k: KpiCard): void }) {
  const { data, error } = useGet<{ objectives: Objective[]; kpis: KpiCard[] }>("/objectives");
  const { me } = useEnt();
  const [panel, setPanel] = useState<"goal" | "import" | null>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="sx-loading">Loading…</div>;
  return (
    <>
      <PageHead
        index="02"
        title="Goals"
        kicker="Baseline, target, actual and forecast — each figure opens its definition and source."
        aside={
          me.role === "admin" && (
            <>
              <Btn onClick={() => setPanel("import")}>Import CSV</Btn>
              <Btn variant="primary" onClick={() => setPanel("goal")}>
                New goal
              </Btn>
            </>
          )
        }
      />
      <div className="sx-goals">
        {data.kpis.map((k, i) => {
          const o = data.objectives.find((x) => x.id === k.objectiveId)!;
          const fmt = (v: number) => metricValue(v, k.unit, k.currency, true);
          const bandHalf = k.forecast ? (k.forecast.high - k.forecast.value) / (k.unit === "money" ? Math.max(1, k.projection.length) : 1) : 0;
          return (
            <article key={k.objectiveId} className="sx-goal">
              <div className="sx-goal-idx">{String(i + 1).padStart(2, "0")}</div>
              <div className="sx-goal-head">
                <h3>{k.name}</h3>
                <div className="sx-goal-chips">
                  <Chip tone={k.status === "active" ? "good" : "warn"}>{k.status === "active" ? "steering rankings" : `draft — needs ${o.missing.join(", ")}`}</Chip>
                  <Chip tone={freshTone(k)}>{freshLabel(k)}</Chip>
                </div>
              </div>
              <div className="sx-grid sx-figs sx-figs-5">
                <Figure label="Baseline" value={metricValue(k.baseline?.value ?? null, k.unit, k.currency, true)} sub={k.baseline?.label ?? "not set"} onExplain={() => onExplain(k)} />
                <Figure label="Target" value={metricValue(k.target.value, k.unit, k.currency, true)} sub={`by ${date(k.target.deadline)}`} onExplain={() => onExplain(k)} />
                <Figure label="Actual" value={metricValue(k.actual, k.unit, k.currency, true)} sub={k.unit === "money" ? "trailing 13 weeks" : "latest week"} onExplain={() => onExplain(k)} />
                <Figure label="Forecast" value={metricValue(k.forecast?.value ?? null, k.unit, k.currency, true)} sub={k.forecast ? `P(hit) ${pct(k.forecast.pHit)}` : "insufficient data"} onExplain={() => onExplain(k)} />
                <Figure label="Source" value={<span className="sx-fig-text">{k.source}</span>} sub={`${k.metricName} v${k.metricVersion} · owner ${k.ownerName ?? "—"}`} onExplain={() => onExplain(k)} />
              </div>
              {k.series.length > 1 ? (
                <TrendChart
                  label={`${k.metricName} weekly`}
                  series={k.series}
                  projection={k.projection}
                  bandHalf={bandHalf}
                  format={fmt}
                  guide={k.unit === "money" ? { value: k.target.value / 13, label: `weekly pace for target ${fmt(k.target.value / 13)}` } : { value: k.target.value, label: `target ${fmt(k.target.value)}` }}
                />
              ) : (
                <Empty>No observations — map a source to compute this metric (ratios with no denominator report “unknown”, never zero).</Empty>
              )}
              <div className="sx-goal-foot">
                <span>Guardrails: {o.guardrails.join(" · ") || "—"}</span>
                <span>Leading: {o.leadingIndicators.join(" · ") || "—"}</span>
              </div>
            </article>
          );
        })}
      </div>
      {panel === "goal" && <NewGoalPanel onClose={() => setPanel(null)} />}
      {panel === "import" && <ImportPanel onClose={() => setPanel(null)} />}
    </>
  );
}

function NewGoalPanel({ onClose }: { onClose(): void }) {
  const { call } = useEnt();
  const metrics = useGet<{ metrics: MetricDefinition[] }>("/metrics");
  const members = useGet<{ members: Member[] }>("/members");
  const { busy, error, run } = useAction();
  const [f, setF] = useState({ name: "", metricId: "", direction: "increase", target: "", ownerId: "", deadline: "", baseValue: "", baseStart: "", baseEnd: "" });
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const metric = metrics.data?.metrics.find((m) => m.id === f.metricId);
  const scale = metric?.unit === "money" ? 100 : metric?.unit === "ratio" ? 0.01 : 1;
  return (
    <SlidePanel title="New goal" kicker="A goal steers rankings only once it has an owner, a mapped source, a baseline period and a target date." onClose={onClose}>
      <div className="sx-form">
        <Field label="Name">
          <input value={f.name} onChange={up("name")} placeholder="Grow gross profit 10%" />
        </Field>
        <Field label="Metric">
          <select value={f.metricId} onChange={up("metricId")}>
            <option value="">Choose…</option>
            {metrics.data?.metrics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.unit}, v{m.version})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Direction">
          <select value={f.direction} onChange={up("direction")}>
            <option value="increase">Increase</option>
            <option value="decrease">Decrease</option>
          </select>
        </Field>
        <Field label={`Target ${metric?.unit === "money" ? "(major units)" : metric?.unit === "ratio" ? "(%)" : ""}`}>
          <input type="number" value={f.target} onChange={up("target")} />
        </Field>
        <Field label="Owner">
          <select value={f.ownerId} onChange={up("ownerId")}>
            <option value="">Unassigned</option>
            {members.data?.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {roleLabel(m.role)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target date">
          <input type="date" value={f.deadline} onChange={up("deadline")} />
        </Field>
        <div className="sx-form-row">
          <Field label="Baseline value">
            <input type="number" value={f.baseValue} onChange={up("baseValue")} />
          </Field>
          <Field label="Baseline from">
            <input type="date" value={f.baseStart} onChange={up("baseStart")} />
          </Field>
          <Field label="to">
            <input type="date" value={f.baseEnd} onChange={up("baseEnd")} />
          </Field>
        </div>
        <ErrorLine error={error} />
        <Btn
          variant="primary"
          disabled={busy || !f.name || !f.metricId || f.target === ""}
          onClick={async () => {
            const ok = await run(() =>
              call("POST", "/objectives", {
                name: f.name,
                metricId: f.metricId,
                direction: f.direction,
                targetValue: Number(f.target) * scale,
                ...(f.ownerId ? { ownerId: f.ownerId } : {}),
                ...(f.deadline ? { deadline: f.deadline } : {}),
                ...(f.baseValue && f.baseStart && f.baseEnd ? { baseline: { value: Number(f.baseValue) * scale, periodStart: f.baseStart, periodEnd: f.baseEnd } } : {}),
              }),
            );
            if (ok) onClose();
          }}
        >
          Create goal
        </Btn>
      </div>
    </SlidePanel>
  );
}

const SAMPLE_CSV = `invoice_id,date,amount,currency,segment,plan
INV-9001,${new Date().toISOString().slice(0, 10)},1840.00,USD,mid,annual
INV-9002,${new Date().toISOString().slice(0, 10)},960.50,USD,smb,monthly
INV-9002,${new Date().toISOString().slice(0, 10)},960.50,USD,smb,monthly
INV-9003,,410.00,USD,smb,monthly
INV-9004,${new Date().toISOString().slice(0, 10)},1200.00,EUR,ent,annual`;

function ImportPanel({ onClose }: { onClose(): void }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [map, setMap] = useState({ externalId: "invoice_id", occurredAt: "date", amount: "amount", currency: "currency", segment: "segment", plan: "plan" });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const body = (dryRun: boolean) => ({
    csv,
    dryRun,
    source: "upload.csv",
    mapping: { externalId: map.externalId, occurredAt: map.occurredAt, amount: map.amount, ...(map.currency ? { currency: map.currency } : {}), defaultCurrency: "USD", extra: { ...(map.segment ? { segment: map.segment } : {}), ...(map.plan ? { plan: map.plan } : {}), stage: "" } },
  });
  // "stage" is fixed to paid for billing exports: add it as a constant column.
  const withStage = (b: ReturnType<typeof body>) => {
    const lines = b.csv.split(/\r?\n/);
    const csv2 = lines.map((l, i) => (l.trim() === "" ? l : `${l},${i === 0 ? "stage" : "paid"}`)).join("\n");
    return { ...b, csv: csv2, mapping: { ...b.mapping, extra: { ...b.mapping.extra, stage: "stage" } } };
  };
  return (
    <SlidePanel title="Import billing CSV" kicker="Preview duplicates, missing and invalid rows before anything is written. Replays import nothing twice." onClose={onClose} wide>
      <div className="sx-form">
        <Field label="CSV" hint="Paste, or pick a file.">
          <textarea rows={7} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} className="sx-mono" />
        </Field>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setCsv(await file.text());
          }}
        />
        <div className="sx-form-row sx-form-row-3">
          {(Object.keys(map) as (keyof typeof map)[]).map((k) => (
            <Field key={k} label={`${k} ←`}>
              <input value={map[k]} onChange={(e) => setMap({ ...map, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="dp-actions">
          <Btn disabled={busy} onClick={() => run(async () => setPreview((await call<{ preview: ImportPreview }>("POST", "/imports", withStage(body(true)), { idempotent: false })).preview))}>
            Preview
          </Btn>
          <Btn variant="primary" disabled={busy || !preview || preview.rows.length === 0} onClick={() => run(async () => setDone((await call<{ imported: number }>("POST", "/imports", withStage(body(false)))).imported))}>
            Import {preview?.rows.length ?? 0} rows
          </Btn>
        </div>
        <ErrorLine error={error} />
        {done !== null && <Chip tone="good">{done} rows imported — metrics recompute from versioned mappings</Chip>}
        {preview && (
          <>
            <div className="sx-grid sx-figs sx-figs-4">
              <Figure label="Ready" value={preview.rows.length} />
              <Figure label="Duplicates" value={preview.duplicates.length} />
              <Figure label="Missing fields" value={preview.missing.length} />
              <Figure label="Invalid" value={preview.invalid.length} />
            </div>
            <ul className="sx-log">
              {[...preview.duplicates.map((x) => ({ ...x, k: "duplicate" })), ...preview.missing.map((x) => ({ ...x, k: "missing" })), ...preview.invalid.map((x) => ({ ...x, k: "invalid" }))]
                .sort((a, b) => a.line - b.line)
                .map((x) => (
                  <li key={x.k + x.line}>
                    <Chip tone={x.k === "invalid" ? "bad" : "warn"}>{x.k}</Chip>
                    <span>
                      line {x.line}: {x.reason}
                    </span>
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
    </SlidePanel>
  );
}

// ===========================================================================
// Decisions
// ===========================================================================

export function DecisionsPage({ onOpen }: { onOpen: Open }) {
  const { data, error } = useGet<{ decisions: DecisionSummary[] }>("/decisions");
  const { me, currency } = useEnt();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const list = (data?.decisions ?? []).filter((d) => filter === "all" || !["Debriefed", "Cancelled", "Rejected"].includes(d.state));
  const byState = useMemoGroups(list);
  if (error) return <ErrorLine error={error} />;
  return (
    <>
      <PageHead
        index="03"
        title="Decisions"
        kicker="Compare a no-change baseline and alternatives in Orion, approve one, and keep the forecast."
        aside={
          <>
            <div className="sx-seg" role="tablist" aria-label="Filter">
              <button type="button" role="tab" aria-selected={filter === "open"} onClick={() => setFilter("open")}>
                Open
              </button>
              <button type="button" role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>
                All
              </button>
            </div>
            {["lead", "executive", "admin"].includes(me.role) && (
              <Btn variant="primary" onClick={() => setCreating(true)}>
                New decision
              </Btn>
            )}
          </>
        }
      />
      {!data ? (
        <div className="sx-loading">Loading…</div>
      ) : (
        <div className="sx-board">
          {byState.map(([state, items]) => (
            <section key={state} className="sx-board-col" aria-label={STATE_LABEL[state]}>
              <header>
                <Chip tone={stateTone(state)}>{STATE_LABEL[state]}</Chip>
                <span className="sx-muted">{items.length}</span>
              </header>
              {items.map((d) => (
                <button key={d.id} type="button" className="sx-card" onClick={() => onOpen(d.id)}>
                  <b>{d.title}</b>
                  <span className="sx-muted">{d.objectiveName}</span>
                  <span className="sx-card-figs">
                    <span>{money(d.evContributionMinor, currency)}</span>
                    <span>{d.pGoal !== null ? `P(goal) ${pct(d.pGoal)}` : "—"}</span>
                  </span>
                  {d.closeCall && <Chip tone="warn">close call</Chip>}
                  <span className="sx-muted">
                    rev {d.revision} · {ago(d.updatedAt)}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
      {creating && (
        <NewDecisionPanel
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onOpen(id);
          }}
        />
      )}
    </>
  );
}

function useMemoGroups(list: DecisionSummary[]) {
  return useMemo(() => {
    const order = ["Draft", "NeedsEvidence", "Evaluated", "AwaitingApproval", "Approved", "Executing", "DeliveryReview", "Measuring", "Debriefed", "Rejected", "Cancelled"];
    const groups = new Map<string, DecisionSummary[]>();
    for (const d of list) groups.set(d.state, [...(groups.get(d.state) ?? []), d]);
    return order.filter((s) => groups.has(s)).map((s) => [s, groups.get(s)!] as [DecisionSummary["state"], DecisionSummary[]]);
  }, [list]);
}

interface CandidateDraft {
  name: string;
  hypothesis: string;
  spend: string;
  cost: string;
  p: [string, string, string];
  inc: [string, string, string];
  moat: string;
  moatP: string;
  moatValue: string;
}

const blankCandidate = (): CandidateDraft => ({ name: "", hypothesis: "", spend: "", cost: "", p: ["25", "50", "25"], inc: ["", "", ""], moat: "", moatP: "", moatValue: "" });

function NewDecisionPanel({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const { call } = useEnt();
  const objectives = useGet<{ objectives: Objective[] }>("/objectives");
  const { busy, error, run } = useAction();
  const [title, setTitle] = useState("");
  const [hyp, setHyp] = useState("");
  const [objectiveId, setObjectiveId] = useState("");
  const [cands, setCands] = useState<CandidateDraft[]>([blankCandidate()]);
  const useTemplate = () => {
    const asOf = new Date().toISOString();
    const toDraft = (a: ReturnType<typeof leadFollowUpAlternative>): CandidateDraft => ({
      name: a.name,
      hypothesis: a.hypothesis ?? "",
      spend: String(a.spendMinor / 100),
      cost: String((a.scenarios[0].actionCostMinor ?? 0) / 100),
      p: a.scenarios.map((s) => String((s.probability ?? 0) * 100)) as [string, string, string],
      inc: a.scenarios.map((s) => String((s.revenueMinor! - baselineAlternative(asOf).scenarios[0].revenueMinor!) / 100)) as [string, string, string],
      moat: a.moat?.mechanism ?? "",
      moatP: a.moat ? String(a.moat.pCreatedRetained * 100) : "",
      moatValue: a.moat ? String(a.moat.conditionalValueMinor / 100) : "",
    });
    setTitle("Lift trial-to-paid conversion (pilot 2)");
    setHyp("Faster human follow-up converts more inbound trials.");
    setCands([toDraft(leadFollowUpAlternative(asOf)), toDraft(annualPlanAlternative(asOf))]);
  };
  const upd = (i: number, patch: Partial<CandidateDraft>) => setCands(cands.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const submit = async () => {
    const asOf = new Date().toISOString();
    const base = baselineAlternative(asOf);
    const labels = ["Downside", "Base", "Upside"];
    const alternatives = [
      base,
      ...cands.map((c, i) => ({
        id: `alt-${i + 1}`,
        name: c.name || `Option ${i + 1}`,
        isBaseline: false,
        hypothesis: c.hypothesis,
        spendMinor: Math.round(Number(c.spend || 0) * 100),
        timeToEffectDays: 21,
        assumptions: [
          { key: "probabilities", label: "Scenario probabilities", value: c.p.join(" / "), provenance: { source: "decision author", asOf, origin: "estimated" as const } },
          { key: "lift", label: "Incremental revenue", value: c.inc.join(" / "), provenance: { source: "decision author", asOf, origin: "estimated" as const } },
        ],
        ...(c.moat && c.moatP && c.moatValue ? { moat: { mechanism: c.moat, pCreatedRetained: Number(c.moatP) / 100, conditionalValueMinor: Math.round(Number(c.moatValue) * 100), horizonMonths: 12 } } : {}),
        scenarios: base.scenarios.map((s, k) => ({
          key: s.key,
          label: labels[k],
          probability: c.p[k] === "" ? null : Number(c.p[k]) / 100,
          revenueMinor: c.inc[k] === "" ? null : s.revenueMinor! + Math.round(Number(c.inc[k]) * 100),
          actionCostMinor: c.cost === "" ? null : Math.round(Number(c.cost) * 100),
        })),
      })),
    ];
    await run(async () => {
      const r = await call<{ decision: { id: string } }>("POST", "/decisions", { objectiveId, title, hypothesis: hyp, horizonDays: 90, cohortSize: 420, alternatives });
      await call("POST", `/decisions/${r.decision.id}/evaluations`, {});
      onCreated(r.decision.id);
    });
  };
  return (
    <SlidePanel title="New decision" kicker="A no-change baseline is always included. Leave a figure blank if unknown — Orion will ask for it." onClose={onClose} wide>
      <div className="sx-form">
        <div className="dp-actions">
          <Btn variant="quiet" onClick={useTemplate}>
            Start from the revenue template
          </Btn>
        </div>
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Hypothesis">
          <textarea rows={2} value={hyp} onChange={(e) => setHyp(e.target.value)} />
        </Field>
        <Field label="Goal">
          <select value={objectiveId} onChange={(e) => setObjectiveId(e.target.value)}>
            <option value="">Choose…</option>
            {objectives.data?.objectives.map((o) => (
              <option key={o.id} value={o.id} disabled={o.status !== "active"}>
                {o.name}
                {o.status !== "active" ? " (draft)" : ""}
              </option>
            ))}
          </select>
        </Field>
        {cands.map((c, i) => (
          <fieldset key={i} className="sx-fieldset">
            <legend>Candidate {i + 1}</legend>
            <div className="sx-form-row">
              <Field label="Name">
                <input value={c.name} onChange={(e) => upd(i, { name: e.target.value })} />
              </Field>
              <Field label="Up-front spend">
                <input type="number" value={c.spend} onChange={(e) => upd(i, { spend: e.target.value })} />
              </Field>
              <Field label="Action cost">
                <input type="number" value={c.cost} onChange={(e) => upd(i, { cost: e.target.value })} />
              </Field>
            </div>
            <table className="sx-table sx-table-tight">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Probability %</th>
                  <th>Incremental revenue</th>
                </tr>
              </thead>
              <tbody>
                {["Downside", "Base", "Upside"].map((label, k) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>
                      <input type="number" aria-label={`Candidate ${i + 1} ${label} probability`} value={c.p[k]} onChange={(e) => upd(i, { p: c.p.map((x, j) => (j === k ? e.target.value : x)) as CandidateDraft["p"] })} />
                    </td>
                    <td>
                      <input type="number" aria-label={`Candidate ${i + 1} ${label} incremental revenue`} value={c.inc[k]} onChange={(e) => upd(i, { inc: c.inc.map((x, j) => (j === k ? e.target.value : x)) as CandidateDraft["inc"] })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sx-form-row">
              <Field label="Durable asset (moat)">
                <input value={c.moat} onChange={(e) => upd(i, { moat: e.target.value })} placeholder="e.g. reusable onboarding workflow" />
              </Field>
              <Field label="P(created & kept) %">
                <input type="number" value={c.moatP} onChange={(e) => upd(i, { moatP: e.target.value })} />
              </Field>
              <Field label="Conditional value">
                <input type="number" value={c.moatValue} onChange={(e) => upd(i, { moatValue: e.target.value })} />
              </Field>
            </div>
          </fieldset>
        ))}
        <div className="dp-actions">
          {cands.length < 4 && <Btn onClick={() => setCands([...cands, blankCandidate()])}>Add candidate</Btn>}
          <Btn variant="primary" disabled={busy || !title || !objectiveId} onClick={submit}>
            Create and evaluate
          </Btn>
        </div>
        <ErrorLine error={error} />
      </div>
    </SlidePanel>
  );
}

// ===========================================================================
// Work (Compass)
// ===========================================================================

const WORK_COLS: { state: WorkView["state"][]; label: string }[] = [
  { state: ["sync_pending", "sync_failed"], label: "Syncing to Compass" },
  { state: ["linked"], label: "In progress" },
  { state: ["in_review"], label: "Delivery review" },
  { state: ["verified"], label: "Verified" },
];

export function WorkPage({ onOpen }: { onOpen: Open }) {
  const { data, error } = useGet<{ work: WorkView[] }>("/work");
  const outbox = useGet<{ outbox: OutboxAction[] }>("/outbox");
  const { me, call } = useEnt();
  const [evidenceFor, setEvidenceFor] = useState<WorkView | null>(null);
  const [reviewFor, setReviewFor] = useState<WorkView | null>(null);
  const { error: actErr, run } = useAction();
  if (error) return <ErrorLine error={error} />;
  const work = (data?.work ?? []).filter((w) => w.state !== "cancelled");
  return (
    <>
      <PageHead index="04" title="Work" kicker="Compass is authoritative for work state. Each task carries its decision's action ID, so a retry never duplicates it." aside={<Chip tone="neutral">Compass · isolated local workspace</Chip>} />
      <ErrorLine error={actErr} />
      <div className="sx-board sx-board-4">
        {WORK_COLS.map((col) => {
          const items = work.filter((w) => col.state.includes(w.state));
          return (
            <section key={col.label} className="sx-board-col" aria-label={col.label}>
              <header>
                <span className="sx-board-title">{col.label}</span>
                <span className="sx-muted">{items.length}</span>
              </header>
              {items.map((w) => (
                <div key={w.id} className="sx-card sx-card-static">
                  <span className="sx-card-id">{w.compassTaskId ?? "—"}</span>
                  <b>{w.title}</b>
                  <button type="button" className="sx-link" onClick={() => onOpen(w.decisionId)}>
                    {w.decisionTitle}
                  </button>
                  <ul className="sx-done-when">
                    {w.doneWhen.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                  <span className="sx-muted">
                    {w.assigneeName} · {w.evidence.length} evidence
                  </span>
                  {w.lastError && <span className="sx-error-inline">{w.lastError}</span>}
                  <div className="sx-card-actions">
                    {(w.state === "linked" || w.state === "in_review") && ["operator", "lead", "admin"].includes(me.role) && (me.role !== "operator" || w.assigneeId === me.id) && (
                      <Btn variant="ghost" onClick={() => setEvidenceFor(w)}>
                        Submit evidence
                      </Btn>
                    )}
                    {w.state === "in_review" && ["finance", "executive"].includes(me.role) && (
                      <Btn variant="primary" onClick={() => setReviewFor(w)}>
                        Review delivery
                      </Btn>
                    )}
                    {w.state === "sync_failed" && (
                      <Btn onClick={() => run(() => call("POST", `/work/${w.id}/requeue`, {}))}>Requeue</Btn>
                    )}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <SectionHead index="4.1" title="Outbox" aside={<span className="sx-muted">approval and dispatch commit together; delivery reconciles by action ID</span>} />
      <div className="sx-table-wrap">
        <table className="sx-table sx-table-tight">
          <thead>
            <tr>
              <th>Action ID</th>
              <th>Revision</th>
              <th>State</th>
              <th className="num">Attempts</th>
              <th>Next attempt</th>
            </tr>
          </thead>
          <tbody>
            {(outbox.data?.outbox ?? []).map((o) => (
              <tr key={o.actionId}>
                <td>
                  <code>{o.actionId}</code>
                </td>
                <td>{o.decisionRevision}</td>
                <td>
                  <Chip tone={o.state === "done" ? "good" : o.state === "pending" ? "warn" : "bad"}>{o.state.replace("_", " ")}</Chip>
                </td>
                <td className="num">{o.attempts}</td>
                <td>{o.state === "pending" ? date(o.nextAttemptAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {evidenceFor && <EvidencePanel work={evidenceFor} onClose={() => setEvidenceFor(null)} />}
      {reviewFor && <DeliveryReviewPanel work={reviewFor} onClose={() => setReviewFor(null)} />}
    </>
  );
}

function EvidencePanel({ work, onClose }: { work: WorkView; onClose(): void }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"file" | "link" | "note">("file");
  const [note, setNote] = useState("");
  const [digest, setDigest] = useState<string | null>(null);
  const [sensitivity, setSensitivity] = useState<"internal" | "confidential" | "public">("internal");
  return (
    <SlidePanel title="Submit completion evidence" kicker={`${work.compassTaskId} · ${work.title}`} onClose={onClose}>
      <div className="sx-form">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call log export, week 1–3" />
        </Field>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="file">File</option>
            <option value="link">Link</option>
            <option value="note">Note</option>
          </select>
        </Field>
        {kind === "file" ? (
          <Field label="File" hint="Only its SHA-256 digest is recorded here; the object store keeps the file.">
            <input
              type="file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setDigest(await sha256Hex(await f.arrayBuffer()));
                  if (!title) setTitle(f.name);
                }
              }}
            />
          </Field>
        ) : (
          <Field label={kind === "link" ? "URL" : "Note"}>
            <textarea
              rows={3}
              value={note}
              onChange={async (e) => {
                setNote(e.target.value);
                setDigest(e.target.value ? await sha256Hex(e.target.value) : null);
              }}
            />
          </Field>
        )}
        <Field label="Sensitivity">
          <select value={sensitivity} onChange={(e) => setSensitivity(e.target.value as typeof sensitivity)}>
            <option value="internal">Internal</option>
            <option value="confidential">Confidential</option>
            <option value="public">Public</option>
          </select>
        </Field>
        {digest && (
          <p className="sx-muted">
            Digest <code>{digest}</code>
          </p>
        )}
        <h4 className="sx-mini-h">Done when</h4>
        <ul className="sx-done-when">
          {work.doneWhen.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <ErrorLine error={error} />
        <Btn
          variant="primary"
          disabled={busy || !title || !digest}
          onClick={async () => {
            if (await run(() => call("POST", `/work/${work.id}/evidence`, { title, kind, digest, sensitivity }))) onClose();
          }}
        >
          Submit for review
        </Btn>
      </div>
    </SlidePanel>
  );
}

function DeliveryReviewPanel({ work, onClose }: { work: WorkView; onClose(): void }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [reason, setReason] = useState("");
  const send = async (verdict: "verify" | "reject") => {
    if (await run(() => call("POST", `/work/${work.id}/delivery-review`, { verdict, reason }))) onClose();
  };
  return (
    <SlidePanel title="Review delivery" kicker={`${work.compassTaskId} · ${work.title}`} onClose={onClose}>
      <h4 className="sx-mini-h">Done when</h4>
      <ul className="sx-done-when">
        {work.doneWhen.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <h4 className="sx-mini-h">Evidence</h4>
      <ul className="sx-log">
        {work.evidence.map((e) => (
          <li key={e.id}>
            <Chip tone={e.status === "accepted" ? "good" : e.status === "rejected" ? "bad" : "warn"}>{e.status}</Chip>
            <span>
              {e.title} · {e.kind} · {e.sensitivity} · <code>{e.digest.slice(0, 16)}…</code>
            </span>
            <time>{date(e.capturedAt)}</time>
          </li>
        ))}
      </ul>
      <div className="sx-form">
        <Field label="Reason">
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorLine error={error} />
        <div className="dp-actions">
          <Btn variant="primary" disabled={busy || !reason} onClick={() => send("verify")}>
            Verify delivery
          </Btn>
          <Btn variant="danger" disabled={busy || !reason} onClick={() => send("reject")}>
            Reject evidence
          </Btn>
        </div>
      </div>
    </SlidePanel>
  );
}

// ===========================================================================
// Outcomes
// ===========================================================================

export function OutcomesPage({ onOpen }: { onOpen: Open }) {
  const out = useGet<{ outcomes: (Outcome & { decisionTitle: string })[] }>("/outcomes");
  const today = useGet<TodayView>("/today");
  const decisions = useGet<{ decisions: DecisionSummary[] }>("/decisions");
  const moats = useGet<{ moats: (MoatAsset & { potentialMinor: number; decisionTitle: string })[] }>("/moats");
  const { me } = useEnt();
  const [registerFor, setRegisterFor] = useState<DecisionSummary | null>(null);
  const [reviewFor, setReviewFor] = useState<Outcome | null>(null);
  const [advance, setAdvance] = useState<MoatAsset | null>(null);
  const { error } = useAction();
  const cur = today.data?.profile.currency ?? "USD";
  const measuring = (decisions.data?.decisions ?? []).filter((d) => d.state === "Measuring");
  const outcomes = out.data?.outcomes ?? [];
  return (
    <>
      <PageHead index="05" title="Outcomes" kicker="Delivery evidence, causal evidence, observed results and the next review. Forecast accuracy and intervention impact are measured separately." />
      <ErrorLine error={error} />
      {measuring.length > 0 && (
        <>
          <SectionHead index="5.1" title="Awaiting measurement" />
          <ul className="sx-rows">
            {measuring.map((d) => (
              <li key={d.id} className="sx-row sx-row-static">
                <span className="sx-row-main">
                  <b>{d.title}</b>
                  <span className="sx-muted">{outcomes.some((o) => o.decisionId === d.id && o.status === "pending_review") ? "Outcome registered · awaiting finance review" : "Delivery verified · register the cohort comparison"}</span>
                </span>
                {["lead", "executive", "admin"].includes(me.role) && !outcomes.some((o) => o.decisionId === d.id && o.status === "pending_review") && (
                  <Btn variant="primary" onClick={() => setRegisterFor(d)}>
                    Register outcome
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionHead index="5.2" title="Predicted against measured" />
      <PredictedVsMeasured
        currency={cur}
        rows={outcomes.map((o) => ({
          label: o.decisionTitle,
          predicted: { ev: o.predicted.evRevenueMinor },
          measured: {
            value: o.measurement.incrementalTotalMinor,
            low: o.measurement.ci95 ? o.measurement.ci95.lowMinor * o.measurement.treatedN : null,
            high: o.measurement.ci95 ? o.measurement.ci95.highMinor * o.measurement.treatedN : null,
          },
        }))}
      />

      <div className="sx-outcomes">
        {outcomes.map((o) => (
          <article key={o.id} className="sx-outcome">
            <header>
              <button type="button" className="sx-link sx-h3" onClick={() => onOpen(o.decisionId)}>
                {o.decisionTitle}
              </button>
              <Chip tone={o.status === "verified" ? "good" : o.status === "disputed" ? "bad" : "warn"}>{o.status.replace("_", " ")}</Chip>
            </header>
            <div className="sx-grid sx-figs sx-figs-4">
              <Figure label="Measured incremental" value={money(o.measurement.incrementalTotalMinor, cur, { signed: true })} sub={`${o.measurement.treatedN} treated vs ${o.measurement.comparisonN} comparison`} />
              <Figure label="Lift per account" value={money(o.measurement.liftPerUnitMinor, cur, { signed: true })} sub={o.measurement.ci95 ? `95% CI ${money(o.measurement.ci95.lowMinor, cur)} … ${money(o.measurement.ci95.highMinor, cur)}` : "no interval"} />
              <Figure label="Predicted (EV)" value={money(o.predicted.evRevenueMinor, cur)} sub={`P(goal) ${pct(o.predicted.pGoal)} · goal ${o.goalMet ? "met" : "missed"}`} />
              <Figure label="Attribution" value={<span className="sx-fig-text">{o.measurement.attribution.replace("_", "-")}</span>} sub={o.measurement.confidenceLabel} />
            </div>
            <Facts
              rows={[
                ["Window", `${date(o.windowStart)} → ${date(o.windowEnd)}`],
                ["Metric", `${o.metricId} v${o.metricVersion}`],
                ["Evaluation", <code key="e">{o.evaluationId}</code>],
                ["Source rows", `${o.sourceRowIds.length} rows traced`],
                ["Review", o.reviewRationale ? `${o.reviewRationale} · next: ${o.next ?? "—"} · revisit ${o.revisitOn ?? "—"}` : "pending"],
              ]}
            />
            {o.status === "pending_review" && ["finance", "executive"].includes(me.role) && (
              <div className="dp-actions">
                <Btn variant="primary" onClick={() => setReviewFor(o)}>
                  Review outcome
                </Btn>
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="sx-cols sx-cols-even">
        <section className="sx-col">
          <SectionHead index="5.3" title="Forecast calibration" />
          {today.data && (
            <>
              <Calibration points={today.data.calibration.points} />
              <p className="sx-note">
                Brier {today.data.calibration.score?.toFixed(3) ?? "—"} against base-rate {today.data.calibration.baseline?.toFixed(3) ?? "—"} over {today.data.calibration.n} forecasts stored before action. Large dots: binned hit rate; diagonal: perfect calibration. Tenant-specific.
              </p>
            </>
          )}
        </section>
        <section className="sx-col sx-col-wide">
          <SectionHead index="5.4" title="Durable assets" />
          <ul className="sx-rows">
            {(moats.data?.moats ?? []).map((m) => (
              <li key={m.id} className="sx-row sx-row-static">
                <span className="sx-row-main">
                  <b>{m.mechanism}</b>
                  <span className="sx-muted">
                    {m.decisionTitle} · {m.horizonMonths} mo horizon · {m.evidence.join(" · ") || "no evidence yet"}
                  </span>
                </span>
                <span className="sx-row-num">
                  {money(m.realizedMinor ?? m.potentialMinor, cur)}
                  <small>{m.realizedMinor !== null ? "realized" : `${pct(m.pCreatedRetained)} × ${money(m.conditionalValueMinor, cur, { compact: true })}`}</small>
                </span>
                <span className="sx-stages" aria-label={`Stage ${m.stage}`}>
                  {["proposed", "created", "verified", "realized"].map((s) => (
                    <i key={s} className={["proposed", "created", "verified", "realized"].indexOf(s) <= ["proposed", "created", "verified", "realized"].indexOf(m.stage) ? "on" : ""} title={s} />
                  ))}
                  <span>{m.stage}</span>
                </span>
                {m.stage !== "realized" && ["lead", "executive", "admin"].includes(me.role) && (
                  <Btn variant="quiet" onClick={() => setAdvance(m)}>
                    Advance
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      {registerFor && <RegisterOutcomePanel decision={registerFor} onClose={() => setRegisterFor(null)} />}
      {reviewFor && <ReviewOutcomePanel outcome={reviewFor} onClose={() => setReviewFor(null)} />}
      {advance && <MoatAdvancePanel moat={advance} currency={cur} onClose={() => setAdvance(null)} />}
    </>
  );
}

const NEXT_STAGE = { proposed: "created", created: "verified", verified: "realized", realized: null } as const;

function MoatAdvancePanel({ moat, currency, onClose }: { moat: MoatAsset; currency: string; onClose(): void }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [evidence, setEvidence] = useState("");
  const [realized, setRealized] = useState("");
  const next = NEXT_STAGE[moat.stage];
  return (
    <SlidePanel title={`Mark asset ${next}`} kicker={moat.mechanism} onClose={onClose}>
      <div className="sx-form">
        <Field label="Evidence" hint="What shows adoption or reuse — who uses it, where it is recorded.">
          <textarea rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
        {next === "realized" && (
          <Field label={`Realized value (${currency})`}>
            <input type="number" value={realized} onChange={(e) => setRealized(e.target.value)} />
          </Field>
        )}
        <ErrorLine error={error} />
        <Btn
          variant="primary"
          disabled={busy || !evidence || (next === "realized" && realized === "")}
          onClick={async () => {
            if (await run(() => call("POST", `/moats/${moat.id}/advance`, { evidence, ...(next === "realized" ? { realizedMinor: Math.round(Number(realized) * 100) } : {}) }))) onClose();
          }}
        >
          Mark {next}
        </Btn>
      </div>
    </SlidePanel>
  );
}

function parseValues(text: string): number[] | null {
  const xs = text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((x) => Math.round(Number(x) * 100));
  return xs.length && xs.every(Number.isSafeInteger) ? xs : null;
}

function RegisterOutcomePanel({ decision, onClose }: { decision: DecisionSummary; onClose(): void }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [method, setMethod] = useState<"random_holdout" | "matched_cohort" | "pre_post">("random_holdout");
  const [treated, setTreated] = useState("");
  const [comparison, setComparison] = useState("");
  const [start, setStart] = useState(new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10));
  const t = parseValues(treated);
  const c = parseValues(comparison);
  return (
    <SlidePanel title="Register outcome" kicker={decision.title} onClose={onClose}>
      <div className="sx-form">
        <Field label="Comparison method" hint="Prefer a random holdout. Pre/post is labelled descriptive, not attribution.">
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="random_holdout">Random holdout</option>
            <option value="matched_cohort">Matched cohort</option>
            <option value="pre_post">Pre/post</option>
          </select>
        </Field>
        <div className="sx-form-row">
          <Field label="Window start">
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Window end">
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Treated accounts — revenue per account" hint={t ? `${t.length} values` : "comma- or space-separated, major units"}>
          <textarea rows={3} className="sx-mono" value={treated} onChange={(e) => setTreated(e.target.value)} />
        </Field>
        <Field label="Comparison accounts — revenue per account" hint={c ? `${c.length} values` : "comma- or space-separated, major units"}>
          <textarea rows={3} className="sx-mono" value={comparison} onChange={(e) => setComparison(e.target.value)} />
        </Field>
        <Btn
          variant="quiet"
          onClick={() => {
            const gen = (mu: number) => Array.from({ length: 40 }, (_, i) => Math.round(mu + Math.sin(i * 12.9898) * 15 + ((i * 37) % 23) - 11)).join(", ");
            setTreated(gen(62));
            setComparison(gen(31));
          }}
        >
          Fill with pilot sample
        </Btn>
        <ErrorLine error={error} />
        <Btn
          variant="primary"
          disabled={busy || !t || !c}
          onClick={async () => {
            if (await run(() => call("POST", `/decisions/${decision.id}/outcomes`, { method, treatedValues: t, comparisonValues: c, windowStart: start, windowEnd: end }))) onClose();
          }}
        >
          Register for review
        </Btn>
      </div>
    </SlidePanel>
  );
}

function ReviewOutcomePanel({ outcome, onClose }: { outcome: Outcome; onClose(): void }) {
  const { call } = useEnt();
  const { busy, error, run } = useAction();
  const [rationale, setRationale] = useState("");
  const [next, setNext] = useState<"expand" | "revise" | "stop">("expand");
  const [revisit, setRevisit] = useState(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const send = async (verdict: "verified" | "disputed") => {
    if (await run(() => call("POST", `/outcomes/${outcome.id}/review`, { verdict, rationale, next, revisitOn: revisit }))) onClose();
  };
  return (
    <SlidePanel title="Review outcome" kicker={outcome.measurement.confidenceLabel} onClose={onClose}>
      <Facts
        rows={[
          ["Incremental", money(outcome.measurement.incrementalTotalMinor, "USD", { signed: true })],
          ["Per account", money(outcome.measurement.liftPerUnitMinor, "USD", { signed: true })],
          ["95% CI", outcome.measurement.ci95 ? `${money(outcome.measurement.ci95.lowMinor, "USD")} … ${money(outcome.measurement.ci95.highMinor, "USD")}` : "—"],
          ["Metric version", String(outcome.metricVersion)],
          ["Source rows", String(outcome.sourceRowIds.length)],
        ]}
      />
      <div className="sx-form">
        <Field label="Rationale">
          <textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </Field>
        <div className="sx-form-row">
          <Field label="Next">
            <select value={next} onChange={(e) => setNext(e.target.value as typeof next)}>
              <option value="expand">Expand</option>
              <option value="revise">Revise</option>
              <option value="stop">Stop</option>
            </select>
          </Field>
          <Field label="Revisit on">
            <input type="date" value={revisit} onChange={(e) => setRevisit(e.target.value)} />
          </Field>
        </div>
        <ErrorLine error={error} />
        <div className="dp-actions">
          <Btn variant="primary" disabled={busy || !rationale} onClick={() => send("verified")}>
            Verify attribution
          </Btn>
          <Btn variant="danger" disabled={busy || !rationale} onClick={() => send("disputed")}>
            Dispute
          </Btn>
        </div>
      </div>
    </SlidePanel>
  );
}

// ===========================================================================
// Settings
// ===========================================================================

export function SettingsPage({ onReset }: { onReset(): void }) {
  const me = useGet<{ me: Member; profile: TodayView["profile"]; policy: PolicyVersion; compass: string }>("/me");
  const members = useGet<{ members: Member[] }>("/members");
  const policy = useGet<{ policy: PolicyVersion; history: PolicyVersion[] }>("/policy");
  const { me: ident, call } = useEnt();
  const audit = useGet<{ events: AuditEvent[] }>(["auditor", "admin", "finance"].includes(ident.role) ? "/audit?limit=500" : null);
  const { busy, error, run } = useAction();
  const [draft, setDraft] = useState<{ maxLoss: string; maxSpend: string; maxDown: string; maxAge: string; finance: string } | null>(null);
  const p = policy.data?.policy;
  const cur = me.data?.profile.currency ?? "USD";
  const d = draft ?? (p ? { maxLoss: String(p.evaluation.maxLossProbability * 100), maxSpend: String(p.evaluation.maxSpendMinor / 100), maxDown: String(p.evaluation.maxDownsideExposureMinor / 100), maxAge: String(p.evaluation.maxInputAgeDays), finance: String(p.financeApprovalOverMinor / 100) } : null);
  const exportAudit = () => {
    const blob = new Blob([JSON.stringify(audit.data?.events ?? [], null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit-${ident.workspaceId}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <>
      <PageHead index="06" title="Settings" kicker="Company profile, policy, memberships, integrations and audit. Policy changes apply prospectively as a new version." />
      <div className="sx-cols">
        <section className="sx-col">
          <SectionHead index="6.1" title="Company profile" />
          {me.data && (
            <Facts
              rows={[
                ["Company", me.data.profile.name],
                ["Business model", me.data.profile.businessModel],
                ["Currency", me.data.profile.currency],
                ["Timezone", me.data.profile.timezone],
                ["Fiscal year starts", new Date(2026, me.data.profile.fiscalYearStartMonth - 1, 1).toLocaleString("en-GB", { month: "long" })],
                ["Gross margin", me.data.profile.grossMarginBps === null ? "not set" : `${me.data.profile.grossMarginBps / 100}%`],
                ["Data to AI services", me.data.profile.aiDataPolicy.replace("_", " ")],
                ["Profile version", String(me.data.profile.version)],
              ]}
            />
          )}
          <SectionHead index="6.2" title="Integrations" />
          <Facts
            rows={[
              ["Orion", "Deterministic reference evaluator orion-ref-1.0.0 behind the Orion adapter"],
              ["Compass", `${me.data?.compass ?? "local"} — isolated work store until workspace isolation is verified`],
              ["Billing source", "CSV import (Goals → Import CSV)"],
              ["Friday executors", "disabled"],
            ]}
          />
          <div className="dp-actions">
            <Btn variant="quiet" onClick={onReset}>
              Reset demo data
            </Btn>
          </div>
        </section>
        <section className="sx-col sx-col-wide">
          <SectionHead index="6.3" title={`Risk policy · v${p?.version ?? "…"}`} />
          {d && (
            <div className="sx-form">
              <div className="sx-form-row sx-form-row-3">
                <Field label="Max P(loss) %">
                  <input type="number" disabled={ident.role !== "admin"} value={d.maxLoss} onChange={(e) => setDraft({ ...d, maxLoss: e.target.value })} />
                </Field>
                <Field label={`Max spend per action (${cur})`}>
                  <input type="number" disabled={ident.role !== "admin"} value={d.maxSpend} onChange={(e) => setDraft({ ...d, maxSpend: e.target.value })} />
                </Field>
                <Field label={`Max downside exposure (${cur})`}>
                  <input type="number" disabled={ident.role !== "admin"} value={d.maxDown} onChange={(e) => setDraft({ ...d, maxDown: e.target.value })} />
                </Field>
                <Field label="Max input age (days)">
                  <input type="number" disabled={ident.role !== "admin"} value={d.maxAge} onChange={(e) => setDraft({ ...d, maxAge: e.target.value })} />
                </Field>
                <Field label={`Finance approval above (${cur})`}>
                  <input type="number" disabled={ident.role !== "admin"} value={d.finance} onChange={(e) => setDraft({ ...d, finance: e.target.value })} />
                </Field>
              </div>
              {ident.role === "admin" && (
                <Btn
                  variant="primary"
                  disabled={busy || !draft}
                  onClick={async () => {
                    if (
                      await run(() =>
                        call("POST", "/policy", {
                          maxLossProbability: Number(d.maxLoss) / 100,
                          maxSpendMinor: Math.round(Number(d.maxSpend) * 100),
                          maxDownsideExposureMinor: Math.round(Number(d.maxDown) * 100),
                          maxInputAgeDays: Math.round(Number(d.maxAge)),
                          financeApprovalOverMinor: Math.round(Number(d.finance) * 100),
                        }),
                      )
                    )
                      setDraft(null);
                  }}
                >
                  Save as v{(p?.version ?? 0) + 1}
                </Btn>
              )}
              <ErrorLine error={error} />
            </div>
          )}
          <SectionHead index="6.4" title="Members" />
          <div className="sx-table-wrap">
            <table className="sx-table sx-table-tight">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Role</th>
                  <th>Department</th>
                </tr>
              </thead>
              <tbody>
                {(members.data?.members ?? []).map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.title}</td>
                    <td>{roleLabel(m.role)}</td>
                    <td>{m.department}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.data && (
            <>
              <SectionHead index="6.5" title="Audit" aside={<Btn variant="quiet" onClick={exportAudit}>Export JSON</Btn>} />
              <div className="sx-table-wrap sx-scroll">
                <table className="sx-table sx-table-tight">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>When</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Resource</th>
                      <th>Rev</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...audit.data.events].reverse().map((e) => (
                      <tr key={e.id}>
                        <td className="num">{e.seq}</td>
                        <td>{date(e.at)}</td>
                        <td>{members.data?.members.find((m) => m.id === e.actorId)?.name ?? e.actorId}</td>
                        <td>
                          <code>{e.action}</code>
                        </td>
                        <td className="sx-muted">{e.resource}</td>
                        <td>{e.beforeRevision === e.afterRevision ? (e.afterRevision ?? "—") : `${e.beforeRevision ?? "∅"}→${e.afterRevision}`}</td>
                        <td className="sx-muted">{e.detail ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
