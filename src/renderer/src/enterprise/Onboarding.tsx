import { useMemo, useState } from "react";
import type { BusinessModel } from "@shared/enterprise/api-types";
import { BUSINESS_TEMPLATES } from "@shared/enterprise/templates";
import type { WorkspaceInput } from "@shared/enterprise/templates";

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "INR", "CNY", "SGD", "HKD", "KRW", "BRL", "MXN", "ZAR", "NGN", "KES", "GHS", "EGP", "AED", "SAR", "TRY", "IDR"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** First run: a company describes itself; a §4 template supplies defaults it can edit later. */
export function Onboarding({ onCreate, onCancel }: { onCreate(input: WorkspaceInput): Promise<void>; onCancel?: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [model, setModel] = useState<BusinessModel>("subscription");
  const [currency, setCurrency] = useState("USD");
  const [timezone, setTimezone] = useState(localTimezone);
  const [fiscal, setFiscal] = useState(1);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(timezones, []);
  const template = BUSINESS_TEMPLATES.find((t) => t.model === model)!;
  const ready = companyName.trim() && name.trim();

  return (
    <section className="ob" aria-labelledby="ob-h">
      <header className="ob-head">
        <h2 id="ob-h">Set up your workspace</h2>
        <p>Start from a business-model template. Every goal, metric, guardrail and policy stays editable, and nothing steers a decision until it is backed by your data.</p>
      </header>

      <div className="ob-step">
        <span className="ob-idx">01</span>
        <div className="ob-body">
          <h3>Company</h3>
          <label className="sx-field">
            <span className="sx-field-label">Company name</span>
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Your company" />
          </label>
          <div className="ob-models" role="radiogroup" aria-label="Business model">
            {BUSINESS_TEMPLATES.map((t) => (
              <label key={t.model} className={`ob-model ${model === t.model ? "is-on" : ""}`}>
                <input type="radio" name="model" value={t.model} checked={model === t.model} onChange={() => setModel(t.model)} aria-label={t.label} />
                <span className="ob-model-label">{t.label}</span>
                <span className="ob-model-desc">{t.description}</span>
                <span className="ob-model-goal">Goal · {t.objectiveName}</span>
              </label>
            ))}
          </div>
          <div className="ob-template">
            <span>
              <b>Leading signals</b> {template.leadingIndicators.join(" · ")}
            </span>
            <span>
              <b>Guardrails</b> {template.guardrails.join(" · ")}
            </span>
          </div>
          <div className="sx-form-row sx-form-row-3">
            <label className="sx-field">
              <span className="sx-field-label">Currency</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="sx-field">
              <span className="sx-field-label">Timezone</span>
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} list="ob-zones" />
              <datalist id="ob-zones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </label>
            <label className="sx-field">
              <span className="sx-field-label">Fiscal year starts</span>
              <select value={fiscal} onChange={(e) => setFiscal(Number(e.target.value))}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      <div className="ob-step">
        <span className="ob-idx">02</span>
        <div className="ob-body">
          <h3>You</h3>
          <div className="sx-form-row">
            <label className="sx-field">
              <span className="sx-field-label">Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="sx-field">
              <span className="sx-field-label">Your title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Head of operations" />
            </label>
          </div>
          <p className="sx-note">You become the workspace admin. Add your team in Settings.</p>
        </div>
      </div>

      <div className="ob-step">
        <span className="ob-idx">03</span>
        <div className="ob-body">
          <h3>Start</h3>
          <div className="ob-starts" role="radiogroup" aria-label="Start">
            <label className={`ob-model ${!sample ? "is-on" : ""}`}>
              <input type="radio" name="start" checked={!sample} onChange={() => setSample(false)} aria-label="Start empty" />
              <span className="ob-model-label">Start empty</span>
              <span className="ob-model-desc">Import your billing CSV, confirm the goal, then compare decisions.</span>
            </label>
            <label className={`ob-model ${sample ? "is-on" : ""}`}>
              <input type="radio" name="start" checked={sample} onChange={() => setSample(true)} aria-label="Explore with sample data" />
              <span className="ob-model-label">Explore with sample data</span>
              <span className="ob-model-desc">Six months of generated records, a sample team and decisions in every stage.</span>
            </label>
          </div>
        </div>
      </div>

      {error && (
        <p className="sx-error" role="alert">
          {error}
        </p>
      )}
      <div className="dp-actions ob-actions">
        <button
          type="button"
          className="sx-btn sx-btn-primary"
          disabled={!ready || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onCreate({ companyName: companyName.trim(), businessModel: model, currency, timezone: timezone.trim(), fiscalYearStartMonth: fiscal, admin: { name: name.trim(), title: title.trim() }, sampleData: sample });
            } catch (e) {
              setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
              setBusy(false);
            }
          }}
        >
          Create workspace
        </button>
        {onCancel && (
          <button type="button" className="sx-btn sx-btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
