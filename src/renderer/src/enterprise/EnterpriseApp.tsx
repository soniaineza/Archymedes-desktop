import { useCallback, useEffect, useState } from "react";
import type { BusinessProfile, KpiCard, SessionInfo } from "@shared/enterprise/api-types";
import { roleLabel, useEnt, useGet } from "./client";
import { EntProvider } from "./EntProvider";
import { DecisionPanel } from "./DecisionPanel";
import { DecisionsPage, GoalsPage, OutcomesPage, ProvenancePanel, SettingsPage, TodayPage, WorkPage } from "./views";
import "./enterprise.css";

type Page = "today" | "goals" | "decisions" | "work" | "outcomes" | "settings";
const NAV: { id: Page; label: string; idx: string }[] = [
  { id: "today", label: "Today", idx: "01" },
  { id: "goals", label: "Goals", idx: "02" },
  { id: "decisions", label: "Decisions", idx: "03" },
  { id: "work", label: "Work", idx: "04" },
  { id: "outcomes", label: "Outcomes", idx: "05" },
  { id: "settings", label: "Settings", idx: "06" },
];

const PAGE_KEY = "archymedes.ent.page";

/** Archymedes Desktop — Orion-based enterprise operating system. */
export function EnterpriseApp({ onOpenWorkbench }: { onOpenWorkbench(): void }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const load = useCallback(async () => setSession(await window.archymedes.entSession()), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!session) return <div className="ent ent-boot" />;
  const me = session.identities.find((i) => i.id === session.actorId);
  if (!me)
    return (
      <SignIn
        session={session}
        onPick={async (id) => {
          await window.archymedes.entSignIn(id);
          await load();
        }}
        onOpenWorkbench={onOpenWorkbench}
      />
    );
  return (
    <EntProvider key={me.id} me={me} onSignOut={() => setSession({ ...session, actorId: null })}>
      <Shell
        onOpenWorkbench={onOpenWorkbench}
        onReset={async () => {
          await window.archymedes.entResetDemo();
          await load();
        }}
        identities={session.identities}
        onSwitch={async (id) => {
          await window.archymedes.entSignIn(id);
          await load();
        }}
      />
    </EntProvider>
  );
}

function SignIn({ session, onPick, onOpenWorkbench }: { session: SessionInfo; onPick(id: string): void; onOpenWorkbench(): void }) {
  const tenants = [...new Set(session.identities.map((i) => i.tenantName))];
  return (
    <div className="ent ent-signin">
      <div className="si-grid" aria-hidden />
      <header className="si-head">
        <div className="si-mark">A</div>
        <div>
          <h1>
            Archymedes
            <br />
            Desktop
          </h1>
          <p className="si-formula">
            Winning = Good decisions <span>×</span> Effective execution <span>×</span> Continuous learning
          </p>
        </div>
      </header>
      <main className="si-main">
        <p className="si-lede">Decide where to invest effort, act on the decision, and measure whether it improved the business.</p>
        {tenants.map((t) => (
          <section key={t} className="si-tenant" aria-label={t}>
            <h2>{t}</h2>
            <div className="si-ids">
              {session.identities
                .filter((i) => i.tenantName === t)
                .map((i) => (
                  <button key={i.id} type="button" className="si-id" onClick={() => onPick(i.id)}>
                    <span className="si-id-role">{roleLabel(i.role)}</span>
                    <span className="si-id-name">{i.name}</span>
                    <span className="si-id-title">{i.title}</span>
                  </button>
                ))}
            </div>
          </section>
        ))}
        <p className="si-note">Local pilot sign-in · identity is held by the app’s main process, never asserted per request. OIDC replaces this for hosted workspaces.</p>
      </main>
      <footer className="si-foot">
        <button type="button" className="sx-link" onClick={onOpenWorkbench}>
          Open the coding workbench →
        </button>
      </footer>
    </div>
  );
}

function Shell({ onOpenWorkbench, onReset, identities, onSwitch }: { onOpenWorkbench(): void; onReset(): void; identities: SessionInfo["identities"]; onSwitch(id: string): void }) {
  const { me, setCurrency } = useEnt();
  const [page, setPage] = useState<Page>(() => {
    try {
      const p = localStorage.getItem(PAGE_KEY) as Page | null;
      return p && NAV.some((n) => n.id === p) ? p : "today";
    } catch {
      return "today";
    }
  });
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const [explain, setExplain] = useState<KpiCard | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const meInfo = useGet<{ profile: BusinessProfile; tenant: { name: string } }>("/me");
  useEffect(() => {
    if (meInfo.data) setCurrency(meInfo.data.profile.currency);
  }, [meInfo.data, setCurrency]);
  const go = (p: Page) => {
    setPage(p);
    try {
      localStorage.setItem(PAGE_KEY, p);
    } catch {
      /* per-viewer convenience only */
    }
  };
  const colleagues = identities.filter((i) => i.workspaceId === me.workspaceId || i.tenantName !== me.tenantName);
  return (
    <div className="ent">
      <nav className="ent-rail" aria-label="Primary">
        <div className="ent-brand" title="Archymedes Desktop">
          A
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <button type="button" className={page === n.id ? "is-active" : ""} aria-current={page === n.id ? "page" : undefined} onClick={() => go(n.id)}>
                <span className="ent-rail-idx">{n.idx}</span>
                <span className="ent-rail-label">{n.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="ent-rail-foot" onClick={onOpenWorkbench} title="Coding agent workbench (Friday-style executor)">
          <span className="ent-rail-idx">⌘</span>
          <span className="ent-rail-label">Workbench</span>
        </button>
      </nav>
      <div className="ent-main">
        <header className="ent-top">
          <div className="ent-top-co">
            <b>{meInfo.data?.tenant.name ?? me.tenantName}</b>
            <span className="sx-muted">
              {meInfo.data?.profile.businessModel} · {meInfo.data?.profile.currency} · {meInfo.data?.profile.timezone}
            </span>
          </div>
          <div className="ent-top-orion">
            <span className="ent-pulse" aria-hidden /> Orion · deterministic evaluator ready
          </div>
          <div className="ent-who">
            <button type="button" className="ent-who-btn" aria-haspopup="menu" aria-expanded={whoOpen} onClick={() => setWhoOpen((v) => !v)}>
              <span className="ent-avatar">{me.name.split(" ").map((x) => x[0]).join("")}</span>
              <span>
                <b>{me.name}</b>
                <small>{roleLabel(me.role)}</small>
              </span>
            </button>
            {whoOpen && (
              <div className="ent-who-menu" role="menu">
                <div className="ent-who-h">Switch identity (pilot)</div>
                {colleagues.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    role="menuitem"
                    className={i.id === me.id ? "is-me" : ""}
                    onClick={() => {
                      setWhoOpen(false);
                      onSwitch(i.id);
                    }}
                  >
                    <b>{i.name}</b> <small>{roleLabel(i.role)} · {i.tenantName}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>
        <main className="ent-page" key={page}>
          {page === "today" && <TodayPage onOpen={setOpenDecision} onExplain={setExplain} />}
          {page === "goals" && <GoalsPage onExplain={setExplain} />}
          {page === "decisions" && <DecisionsPage onOpen={setOpenDecision} />}
          {page === "work" && <WorkPage onOpen={setOpenDecision} />}
          {page === "outcomes" && <OutcomesPage onOpen={setOpenDecision} />}
          {page === "settings" && <SettingsPage onReset={onReset} />}
        </main>
      </div>
      {openDecision && <DecisionPanel id={openDecision} onClose={() => setOpenDecision(null)} />}
      {explain && <ProvenancePanel kpi={explain} onClose={() => setExplain(null)} />}
    </div>
  );
}

