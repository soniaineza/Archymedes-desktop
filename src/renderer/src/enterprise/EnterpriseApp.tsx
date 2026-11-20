import { useCallback, useEffect, useState } from "react";
import type { BusinessProfile, KpiCard, SessionInfo } from "@shared/enterprise/api-types";
import { roleLabel, useEnt, useGet } from "./client";
import { EntProvider } from "./EntProvider";
import { Onboarding } from "./Onboarding";
import { GuidePanel, HowItWorks } from "./Guide";
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
export function EnterpriseApp({ onOpenWorkbench, edition = "desktop" }: { onOpenWorkbench(): void; edition?: "desktop" | "web" }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => setSession(await window.archymedes.entSession()), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!session) return <div className="ent ent-boot" />;
  const me = session.identities.find((i) => i.id === session.actorId);
  if (!me || creating)
    return (
      <Welcome edition={edition} onOpenWorkbench={onOpenWorkbench}>
        {session.identities.length === 0 || creating ? (
          <Onboarding
            onCancel={session.identities.length ? () => setCreating(false) : undefined}
            onCreate={async (input) => {
              await window.archymedes.entCreateWorkspace(input);
              setCreating(false);
              await load();
            }}
          />
        ) : (
          <SignIn
            session={session}
            onPick={async (id) => {
              await window.archymedes.entSignIn(id);
              await load();
            }}
            onNew={() => setCreating(true)}
          />
        )}
      </Welcome>
    );
  return (
    <EntProvider key={me.id} me={me} onSignOut={() => setSession({ ...session, actorId: null })}>
      <Shell
        onOpenWorkbench={onOpenWorkbench}
        onReset={async () => {
          await window.archymedes.entReset();
          await load();
        }}
        onNewWorkspace={() => setCreating(true)}
        identities={session.identities}
        onSwitch={async (id) => {
          await window.archymedes.entSignIn(id);
          await load();
        }}
      />
    </EntProvider>
  );
}

function Welcome({ edition, onOpenWorkbench, children }: { edition: "desktop" | "web"; onOpenWorkbench(): void; children: React.ReactNode }) {
  return (
    <div className="ent ent-signin">
      <div className="si-grid" aria-hidden />
      <header className="si-head">
        <div className="si-mark">A</div>
        <div>
          <h1>
            Archymedes
            <br />
            {edition === "web" ? "OS" : "Desktop"}
          </h1>
          <p className="si-formula">
            Winning = Good decisions <span>×</span> Effective execution <span>×</span> Continuous learning
          </p>
        </div>
      </header>
      <main className="si-main">
        <p className="si-lede">Decide where to invest effort, act on the decision, and measure whether it improved the business.</p>
        <HowItWorks />
        {children}
        <p className="si-note">
          {edition === "web"
            ? "Web edition · workspaces run entirely in your browser and are saved only there. Nothing is sent to a server."
            : "Local pilot · workspaces are stored on this computer and identity is held by the app’s main process. OIDC replaces this for hosted workspaces."}
        </p>
      </main>
      <footer className="si-foot">
        <button type="button" className="sx-link" onClick={onOpenWorkbench}>
          Open the coding workbench →
        </button>
      </footer>
    </div>
  );
}

function SignIn({ session, onPick, onNew }: { session: SessionInfo; onPick(id: string): void; onNew(): void }) {
  const workspaces = [...new Map(session.identities.map((i) => [i.workspaceId, i.tenantName])).entries()];
  return (
    <>
      {workspaces.map(([ws, name]) => (
        <section key={ws} className="si-tenant" aria-label={name}>
          <h2>{name}</h2>
          <div className="si-ids">
            {session.identities
              .filter((i) => i.workspaceId === ws)
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
      <button type="button" className="sx-btn sx-btn-ghost" onClick={onNew}>
        Create another workspace
      </button>
    </>
  );
}

function Shell({ onOpenWorkbench, onReset, onNewWorkspace, identities, onSwitch }: { onOpenWorkbench(): void; onReset(): void; onNewWorkspace(): void; identities: SessionInfo["identities"]; onSwitch(id: string): void }) {
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
  const [guide, setGuide] = useState(false);
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
            <span className="ent-pulse" aria-hidden /> Decision engine ready
          </div>
          <button type="button" className="ent-help" onClick={() => setGuide(true)}>
            How it works
          </button>
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
          {page === "settings" && <SettingsPage onReset={onReset} onNewWorkspace={onNewWorkspace} />}
        </main>
      </div>
      {openDecision && <DecisionPanel id={openDecision} onClose={() => setOpenDecision(null)} />}
      {explain && <ProvenancePanel kpi={explain} onClose={() => setExplain(null)} />}
      {guide && <GuidePanel onClose={() => setGuide(false)} />}
    </div>
  );
}

