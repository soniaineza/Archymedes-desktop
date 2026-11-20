import type { CompassTask, EnterpriseState, EntRequest, EntResponse, SessionInfo } from "../../shared/enterprise/api-types";
import { EnterpriseApi } from "./api";
import { LocalCompassAdapter } from "./compass-adapter";
import { buildWorkspace, validateWorkspaceInput } from "../../shared/enterprise/templates";
import type { WorkspaceInput } from "../../shared/enterprise/templates";

export interface Persisted {
  state: EnterpriseState;
  compass: CompassTask[];
  actorId: string | null;
}

/** Where a host keeps its state: a JSON file on desktop, localStorage on the web. */
/** A store with no companies yet: the app opens on onboarding. */
export function emptyState(): EnterpriseState {
  return { schemaVersion: 1, seq: 0, tenants: [], members: [], profiles: [], policies: [], metrics: [], objectives: [], decisions: [], evaluations: [], approvals: [], work: [], evidence: [], outcomes: [], moats: [], audit: [], events: [], outbox: [], rows: [], imports: [], forecasts: [], idempotency: [], jobs: [] };
}

export interface PersistStore {
  load(): Promise<Persisted | null>;
  save(data: Persisted): Promise<void>;
}

/**
 * The local pilot backend, independent of where state is stored: one
 * EnterpriseApi, the signed-in identity, and the evaluation worker and outbox
 * run after each mutation. The identity lives here, never in a request.
 */
export class EnterpriseHost {
  private api!: EnterpriseApi;
  private compass!: LocalCompassAdapter;
  private actorId: string | null = null;
  private loading: Promise<void> | null = null;
  protected readonly now: () => string;

  constructor(
    private readonly store: PersistStore,
    opts: { now?: () => string } = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    let p: Persisted | null = null;
    try {
      p = await this.store.load();
      if (p?.state?.schemaVersion !== 1) p = null;
    } catch {
      p = null;
    }
    this.install(p ?? { state: emptyState(), compass: [], actorId: null });
  }

  private install(p: Persisted): void {
    this.compass = new LocalCompassAdapter(p.compass, this.now);
    this.api = new EnterpriseApi(p.state, { now: this.now, compass: this.compass });
    this.actorId = p.actorId;
  }

  flush(): Promise<void> {
    return this.store.save({ state: this.api.snapshot(), compass: this.compass.dump(), actorId: this.actorId });
  }

  async session(): Promise<SessionInfo> {
    await this.ready();
    const st = this.api.snapshot();
    return {
      actorId: this.actorId,
      identities: st.members.map((m) => {
        const t = st.tenants.find((x) => x.id === m.tenantId)!;
        return { id: m.id, name: m.name, title: m.title, role: m.role, workspaceId: t.workspaceId, tenantName: t.name };
      }),
    };
  }

  async signIn(actorId: string): Promise<void> {
    await this.ready();
    if (!this.api.snapshot().members.some((m) => m.id === actorId)) throw new Error("Unknown identity.");
    this.actorId = actorId;
    await this.flush();
  }

  async request(req: EntRequest): Promise<EntResponse> {
    await this.ready();
    if (!this.actorId) return { status: 401, body: { error: { code: "signed_out", message: "Sign in to a workspace first." } } };
    const res = await this.api.handle(this.actorId, req);
    if (req.method !== "GET") {
      await this.api.runJobs();
      await this.api.drainOutbox();
      await this.flush();
    }
    return res;
  }

  /** Creates a company workspace from a business-model template and signs its admin in. */
  async createWorkspace(input: WorkspaceInput): Promise<void> {
    await this.ready();
    const bad = validateWorkspaceInput(input);
    if (bad.length) throw new Error(`Check these fields: ${bad.join(", ")}`);
    const st = this.api.snapshot();
    let n = 0;
    const stamp = Date.parse(this.now()).toString(36);
    const rand = () => Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
    const w = buildWorkspace(input, this.now(), (prefix) => `${prefix}-${stamp}-${(++n).toString(36)}${rand()}`);
    st.tenants.push(w.tenant);
    st.members.push(...w.members);
    st.profiles.push(w.profile);
    st.policies.push(w.policy);
    st.metrics.push(...w.metrics);
    st.objectives.push(...w.objectives);
    st.rows.push(...w.rows);
    st.imports.push(...w.imports);
    st.decisions.push(...w.decisions);
    st.evaluations.push(...w.evaluations);
    st.approvals.push(...w.approvals);
    st.work.push(...w.work);
    st.evidence.push(...w.evidence);
    st.outcomes.push(...w.outcomes);
    st.moats.push(...w.moats);
    st.forecasts.push(...w.forecasts);
    st.outbox.push(...w.outbox);
    for (const a of w.audit) st.audit.push({ ...a, seq: ++st.seq });
    this.actorId = w.members[0].id;
    await this.flush();
  }

  /** Deletes every local workspace; the app returns to onboarding. */
  async resetAll(): Promise<void> {
    await this.ready();
    this.install({ state: emptyState(), compass: [], actorId: null });
    await this.flush();
  }
}
