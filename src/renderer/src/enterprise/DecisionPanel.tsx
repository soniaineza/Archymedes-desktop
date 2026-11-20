import { useState } from "react";
import type { DecisionDetail, Evaluation } from "@shared/enterprise/api-types";
import type { AlternativeInput, AlternativeResult } from "@shared/enterprise/types";
import { date, EntCallError, money, pct, STATE_LABEL, stateTone, useEnt, useGet } from "./client";
import { Btn, Chip, ErrorLine, Facts, Field, Figure, SectionHead, SlidePanel } from "./ui";
import { LifecycleRail, Meter, RangeStrip, ScenarioChart, Tornado } from "./viz";

const DECIDE = ["lead", "executive", "admin"];

type Confirm = { verdict: "approve" | "reject" | "request_evidence" } | null;

export function DecisionPanel({ id, onClose }: { id: string; onClose(): void }) {
  const { data, error } = useGet<DecisionDetail>(`/decisions/${id}`);
  return (
    <SlidePanel title={data?.decision.title ?? "Decision"} kicker={data ? <DecisionKicker d={data} /> : "Loading…"} onClose={onClose} wide>
      <ErrorLine error={error} />
      {data && <DecisionBody detail={data} />}
    </SlidePanel>
  );
}

function DecisionKicker({ d }: { d: DecisionDetail }) {
  return (
    <span className="sx-kicker-row">
      <Chip tone={stateTone(d.decision.state)}>{STATE_LABEL[d.decision.state]}</Chip>
      <span>rev {d.decision.revision}</span>
      <span>·</span>
      <span>{d.objective.name}</span>
    </span>
  );
}

function DecisionBody({ detail }: { detail: DecisionDetail }) {
  const { me, call } = useEnt();
  const { decision: d, policy } = detail;
  const ev: Evaluation | undefined = detail.evaluations.find((e) => e.id === d.latestEvaluationId);
  const result = ev?.result ?? null;
  const currency = ev?.snapshot.currency ?? "USD";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<EntCallError | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [reason, setReason] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [replay, setReplay] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const canDecide = DECIDE.includes(me.role);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof EntCallError ? e : new EntCallError(0, "error", String(e)));
    } finally {
      setBusy(false);
    }
  };

  const chosen = result?.alternatives.find((a) => a.id === (d.chosenAlternativeId ?? result.recommendationId));
  const candidates = result?.alternatives.filter((a) => !a.isBaseline) ?? [];
  const evs = candidates.flatMap((a) => (a.range ? [a.range.minMinor, a.range.maxMinor] : []));
  const lo = Math.min(0, ...evs);
  const hi = Math.max(0, ...evs);
  const ranked = candidates.filter((a) => a.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const top = ranked[0];

  return (
    <div className="dp">
      <LifecycleRail state={d.state} history={d.history} />
      {d.hypothesis && <p className="dp-hyp">{d.hypothesis}</p>}

      {/* ---- headline figures ---- */}
      <div className="sx-grid sx-figs">
        <Figure label={d.chosenAlternativeId ? "Chosen" : "Orion recommends"} value={chosen?.name ?? (result?.status === "needs_evidence" ? "Needs evidence" : result ? "No eligible option" : "Not evaluated")} size="s" />
        <Figure label="Expected contribution" value={money(chosen?.evContributionMinor, currency)} sub={`${result?.horizonDays ?? d.horizonDays} days, after action cost`} size="l" />
        <Figure label="Expected revenue" value={money(chosen?.evRevenueMinor, currency)} sub="incremental vs no change" />
        <Figure label="P(goal)" value={pct(chosen?.pGoal ?? null)} sub={result?.goalLabel} />
        <Figure label="P(loss)" value={pct(chosen?.pLoss ?? null)} sub={`limit ${pct(policy.evaluation.maxLossProbability)}`} />
        <Figure label="Moat potential" value={money(chosen?.moatPotentialMinor ?? null, currency)} sub="kept separate from revenue" />
      </div>

      {/* ---- actions ---- */}
      <div className="dp-actions">
        {canDecide && ["Draft", "NeedsEvidence", "Evaluated"].includes(d.state) && (
          <Btn variant={d.state === "Evaluated" ? "ghost" : "primary"} disabled={busy} onClick={() => run(() => call("POST", `/decisions/${d.id}/evaluations`, {}))}>
            {d.state === "Evaluated" ? "Re-run Orion" : "Evaluate in Orion"}
          </Btn>
        )}
        {detail.canEdit && !editing && (
          <Btn disabled={busy} onClick={() => setEditing(true)}>
            Revise inputs
          </Btn>
        )}
        {detail.canApprove && !confirm && (
          <>
            <Btn variant="primary" onClick={() => setConfirm({ verdict: "approve" })}>
              Approve
            </Btn>
            <Btn onClick={() => setConfirm({ verdict: "request_evidence" })}>Request evidence</Btn>
            <Btn variant="danger" onClick={() => setConfirm({ verdict: "reject" })}>
              Reject
            </Btn>
          </>
        )}
        {d.state === "AwaitingApproval" && !detail.canApprove && <span className="sx-muted">Awaiting an independent executive or finance approver.</span>}
      </div>

      {confirm && ev && (
        <div className="dp-confirm" role="group" aria-label="Confirm">
          <p>
            You are {confirm.verdict === "approve" ? "approving" : confirm.verdict === "reject" ? "rejecting" : "requesting evidence for"} <b>{chosen?.name}</b> at revision {d.revision}, bound to evaluation <code>{ev.inputHash.slice(0, 12)}</code>.
            {confirm.verdict === "approve" && " Approval creates one Compass task."}
          </p>
          <Field label="Reason">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
          <div className="dp-actions">
            <Btn
              variant={confirm.verdict === "reject" ? "danger" : "primary"}
              disabled={busy || !reason.trim()}
              onClick={() =>
                run(async () => {
                  await call("POST", `/decisions/${d.id}/approvals`, { evaluationId: ev.id, verdict: confirm.verdict, reason }, { ifRevision: d.revision });
                  setConfirm(null);
                  setReason("");
                })
              }
            >
              {confirm.verdict === "approve" ? "Confirm approval" : confirm.verdict === "reject" ? "Confirm rejection" : "Confirm request"}
            </Btn>
            <Btn variant="quiet" onClick={() => setConfirm(null)}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
      <ErrorLine error={err} />

      {editing && <InputsEditor detail={detail} onDone={() => setEditing(false)} />}

      {d.state === "Evaluated" && canDecide && result?.status === "complete" && (
        <div className="dp-confirm">
          <SectionHead title="Submit a choice for approval" />
          <div className="dp-choices">
            {candidates.map((a) => (
              <label key={a.id} className={`dp-choice ${!a.eligible ? "is-gated" : ""}`}>
                <input type="radio" name="choice" disabled={!a.eligible} checked={(choice ?? result.recommendationId) === a.id} onChange={() => setChoice(a.id)} />
                <span>{a.name}</span>
                {a.id === result.recommendationId && <Chip tone="accent">Orion pick</Chip>}
                {!a.eligible && <Chip tone="bad">Gated</Chip>}
              </label>
            ))}
          </div>
          <Field label="Rationale" hint={(choice ?? result.recommendationId) !== result.recommendationId ? "Overriding the recommendation — the rationale is recorded." : undefined}>
            <textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </Field>
          <Btn variant="primary" disabled={busy || !(choice ?? result.recommendationId) || !rationale.trim()} onClick={() => run(() => call("POST", `/decisions/${d.id}/choose`, { alternativeId: choice ?? result.recommendationId, rationale }, { ifRevision: d.revision }))}>
            Submit choice
          </Btn>
        </div>
      )}

      {/* ---- comparison ---- */}
      {result && result.status !== "failed" && (
        <>
          <SectionHead index="A" title="Alternatives, side by side" aside={result.closeCall ? <Chip tone="warn">Close call</Chip> : null} />
          <div className="sx-table-wrap">
            <table className="sx-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Alternative</th>
                  <th className="num">E[contribution]</th>
                  <th className="num">E[revenue]</th>
                  <th>P(goal)</th>
                  <th>P(loss)</th>
                  <th>Range</th>
                  <th className="num">Moat</th>
                  <th>Gates</th>
                </tr>
              </thead>
              <tbody>
                {result.alternatives.map((a) => (
                  <AltRow key={a.id} a={a} currency={currency} lo={lo} hi={hi} limit={policy.evaluation.maxLossProbability} recommended={a.id === result.recommendationId} />
                ))}
              </tbody>
            </table>
          </div>

          <SectionHead index="B" title="Scenarios — width is probability, height is Δ contribution" />
          <ScenarioChart alternatives={result.alternatives} currency={currency} />
          <p className="sx-note">The signed area of each set of columns equals its expected contribution. Baseline: no change, same window and currency.</p>

          {top && result.sensitivities.length > 0 && (
            <>
              <SectionHead index="C" title="What would change the recommendation" />
              <Tornado items={result.sensitivities} ev={top.evContributionMinor!} runnerUp={ranked[1]?.evContributionMinor ?? 0} currency={currency} />
            </>
          )}

          {(result.questions.length > 0 || result.missing.length > 0) && (
            <>
              <SectionHead index="D" title="Questions and missing evidence" />
              <ol className="sx-qlist">
                {result.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
      {result?.status === "failed" && <p className="sx-error">Evaluation failed: {result.failure}</p>}

      <SectionHead index="E" title="Inputs and provenance" />
      <div className="sx-table-wrap">
        <table className="sx-table">
          <thead>
            <tr>
              <th>Alternative</th>
              <th>Input</th>
              <th>Value</th>
              <th>Source</th>
              <th>Origin</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {d.alternatives.flatMap((a) =>
              a.assumptions.map((x) => (
                <tr key={a.id + x.key}>
                  <td>{a.name}</td>
                  <td>{x.label}</td>
                  <td>{x.value}</td>
                  <td>{x.provenance.source}</td>
                  <td>
                    <Chip tone={x.provenance.origin === "observed" ? "good" : x.provenance.origin === "estimated" ? "warn" : "bad"}>{x.provenance.origin}</Chip>
                  </td>
                  <td>{date(x.provenance.asOf)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      {ev && (
        <>
          <SectionHead index="F" title="Evaluation record" aside={<Btn variant="quiet" onClick={() => run(async () => setReplay((await call<{ matches: boolean }>("POST", `/evaluations/${ev.id}/replay`, {}, { idempotent: false })).matches))}>Replay from snapshot</Btn>} />
          <Facts
            rows={[
              ["Evaluation", <code key="i">{ev.id}</code>],
              ["Input hash", <code key="h">{ev.inputHash}</code>],
              ["Calculator", `${ev.evaluatorVersion} · deterministic · no model in the numbers`],
              ["Policy", `version ${ev.policyVersion}`],
              ["Revision", `${ev.decisionRevision}${ev.decisionRevision !== d.revision ? " (superseded)" : ""}`],
              ["Evaluated", date(ev.completedAt ?? ev.createdAt)],
              ["Expires", date(ev.expiresAt)],
              ...(replay === null ? [] : ([["Replay", replay ? <Chip key="r" tone="good">identical result</Chip> : <Chip key="r" tone="bad">mismatch</Chip>]] as [string, React.ReactNode][])),
            ]}
          />
        </>
      )}

      {(detail.approvals.length > 0 || detail.work.length > 0) && (
        <>
          <SectionHead index="G" title="Approvals and Compass work" />
          <ul className="sx-log">
            {detail.approvals.map((a) => (
              <li key={a.id}>
                <Chip tone={a.verdict === "approve" ? (a.active ? "good" : "neutral") : a.verdict === "reject" ? "bad" : "warn"}>{a.verdict.replace("_", " ")}</Chip>
                <span>
                  {a.role} · rev {a.decisionRevision} · {a.reason}
                  {!a.active && a.verdict === "approve" && " · invalidated by a later revision"}
                </span>
                <time>{date(a.createdAt)}</time>
              </li>
            ))}
            {detail.work.map((w) => (
              <li key={w.id}>
                <Chip tone={w.state === "linked" || w.state === "verified" ? "good" : w.state === "sync_failed" || w.state === "cancelled" ? "bad" : "warn"}>{w.state.replace("_", " ")}</Chip>
                <span>
                  <b>{w.compassTaskId ?? "Compass sync pending"}</b> · {w.title} · {w.assigneeName}
                </span>
                <time>{date(w.updatedAt)}</time>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionHead index="H" title="History" />
      <ul className="sx-log">
        {[...d.history].reverse().map((h, i) => (
          <li key={i}>
            <Chip tone={stateTone(h.state)}>{STATE_LABEL[h.state]}</Chip>
            <span>
              rev {h.revision}
              {h.note ? ` · ${h.note}` : ""}
            </span>
            <time>{date(h.at)}</time>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AltRow({ a, currency, lo, hi, limit, recommended }: { a: AlternativeResult; currency: string; lo: number; hi: number; limit: number; recommended: boolean }) {
  return (
    <tr className={recommended ? "is-rec" : a.isBaseline ? "is-base" : ""}>
      <td className="num">{a.rank ?? "—"}</td>
      <td>
        <b>{a.name}</b>
        {a.isBaseline && <span className="sx-muted"> · baseline</span>}
        {recommended && !a.isBaseline && <Chip tone="accent">Orion pick</Chip>}
      </td>
      <td className="num">{money(a.evContributionMinor, currency)}</td>
      <td className="num">{money(a.evRevenueMinor, currency)}</td>
      <td>{a.pGoal !== null && !a.isBaseline ? <Meter value={a.pGoal} label="P(goal)" /> : "—"}</td>
      <td>{a.pLoss !== null && !a.isBaseline ? <Meter value={a.pLoss} limit={limit} label="P(loss)" /> : "—"}</td>
      <td>{a.range && !a.isBaseline ? <RangeStrip min={a.range.minMinor} max={a.range.maxMinor} ev={a.evContributionMinor!} lo={lo} hi={hi} currency={currency} /> : "—"}</td>
      <td className="num">{money(a.moatPotentialMinor, currency)}</td>
      <td>
        <span className="sx-gates">
          {a.gates.length > 0 &&
            (a.gates.every((g) => g.passed) ? (
              <Chip tone="good" title={a.gates.map((g) => g.detail).join("\n")}>
                {a.gates.length}/{a.gates.length} pass
              </Chip>
            ) : (
              a.gates
                .filter((g) => !g.passed)
                .map((g) => (
                  <Chip key={g.key} tone="bad" title={g.detail}>
                    {g.key.replace(/_/g, " ")}
                  </Chip>
                ))
            ))}
          {!a.complete && <Chip tone="warn">incomplete</Chip>}
        </span>
      </td>
    </tr>
  );
}

/** Edit candidate scenarios; saving creates a new revision and voids old approvals. */
function InputsEditor({ detail, onDone }: { detail: DecisionDetail; onDone(): void }) {
  const { call } = useEnt();
  const d = detail.decision;
  const base = d.alternatives.find((a) => a.isBaseline)!;
  const [alts, setAlts] = useState<AlternativeInput[]>(() => structuredClone(d.alternatives));
  const [err, setErr] = useState<EntCallError | null>(null);
  const baseRev = (key: string) => base.scenarios.find((s) => s.key === key)?.revenueMinor ?? 0;
  const set = (ai: number, si: number, field: "probability" | "inc" | "cost", raw: string) =>
    setAlts((prev) => {
      const next = structuredClone(prev);
      const sc = next[ai].scenarios[si];
      const v = raw === "" ? null : Number(raw);
      if (field === "probability") sc.probability = v === null ? null : v / 100;
      if (field === "inc") sc.revenueMinor = v === null ? null : baseRev(sc.key) + Math.round(v * 100);
      if (field === "cost") sc.actionCostMinor = v === null ? null : Math.round(v * 100);
      return next;
    });
  return (
    <div className="dp-confirm">
      <SectionHead title="Revise inputs" aside={<span className="sx-muted">Saving creates revision {d.revision + 1} and invalidates outstanding approvals.</span>} />
      {alts.map((a, ai) =>
        a.isBaseline ? null : (
          <div key={a.id} className="dp-edit">
            <b>{a.name}</b>
            <table className="sx-table sx-table-tight">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Probability %</th>
                  <th>Incremental revenue</th>
                  <th>Action cost</th>
                </tr>
              </thead>
              <tbody>
                {a.scenarios.map((s, si) => (
                  <tr key={s.key}>
                    <td>{s.label}</td>
                    <td>
                      <input aria-label={`${a.name} ${s.label} probability`} type="number" step="1" value={s.probability === null ? "" : Math.round(s.probability * 1000) / 10} onChange={(e) => set(ai, si, "probability", e.target.value)} />
                    </td>
                    <td>
                      <input aria-label={`${a.name} ${s.label} incremental revenue`} type="number" step="100" value={s.revenueMinor === null ? "" : (s.revenueMinor - baseRev(s.key)) / 100} onChange={(e) => set(ai, si, "inc", e.target.value)} />
                    </td>
                    <td>
                      <input aria-label={`${a.name} ${s.label} cost`} type="number" step="100" value={s.actionCostMinor === null ? "" : s.actionCostMinor / 100} onChange={(e) => set(ai, si, "cost", e.target.value)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
      <ErrorLine error={err} />
      <div className="dp-actions">
        <Btn
          variant="primary"
          onClick={async () => {
            try {
              await call("PATCH", `/decisions/${d.id}`, { alternatives: alts }, { ifRevision: d.revision });
              onDone();
            } catch (e) {
              setErr(e as EntCallError);
            }
          }}
        >
          Save as revision {d.revision + 1}
        </Btn>
        <Btn variant="quiet" onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}
