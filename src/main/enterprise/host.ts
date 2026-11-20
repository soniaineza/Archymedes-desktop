import type { CompassTask, EnterpriseState, EntRequest, EntResponse, SessionInfo } from "../../shared/enterprise/api-types";
import { EnterpriseApi } from "./api";
import { LocalCompassAdapter } from "./compass-adapter";
import { seedState } from "./seed";

export interface Persisted {
  state: EnterpriseState;
  compass: CompassTask[];
  actorId: string | null;
}

/** Where a host keeps its state: a JSON file on desktop, localStorage on the web. */
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
    this.install(p ?? { state: seedState(this.now()), compass: [], actorId: null });
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

  async resetDemo(): Promise<void> {
    await this.ready();
    this.install({ state: seedState(this.now()), compass: [], actorId: this.actorId });
    await this.flush();
  }
}
