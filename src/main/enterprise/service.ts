import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompassTask, EnterpriseState, EntRequest, EntResponse, SessionInfo } from "../../shared/enterprise/api-types";
import { EnterpriseApi } from "./api";
import { LocalCompassAdapter } from "./compass-adapter";
import { seedState } from "./seed";

interface Persisted {
  state: EnterpriseState;
  compass: CompassTask[];
  actorId: string | null;
}

/**
 * The desktop's local pilot backend: one EnterpriseApi over a JSON file in
 * userData, plus the signed-in identity. The identity lives here in the main
 * process — the renderer never asserts who it is per request. In a hosted
 * deployment this class is replaced by an HTTP client with OIDC tokens held in
 * the OS keychain; the request/response contract stays the same.
 */
export class EnterpriseService {
  private api!: EnterpriseApi;
  private compass!: LocalCompassAdapter;
  private actorId: string | null = null;
  private loading: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => string;

  constructor(userData: string, opts: { now?: () => string } = {}) {
    this.file = path.join(userData, "enterprise", "state.json");
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    let persisted: Persisted | null = null;
    try {
      persisted = JSON.parse(await fs.readFile(this.file, "utf8")) as Persisted;
      if (persisted.state?.schemaVersion !== 1) persisted = null;
    } catch {
      persisted = null;
    }
    this.install(persisted ?? { state: seedState(this.now()), compass: [], actorId: null });
  }

  private install(p: Persisted): void {
    this.compass = new LocalCompassAdapter(p.compass, this.now);
    this.api = new EnterpriseApi(p.state, { now: this.now, compass: this.compass });
    this.actorId = p.actorId;
  }

  /** Writes are serialized and atomic (temp file + rename). */
  flush(): Promise<void> {
    const data: Persisted = { state: this.api.snapshot(), compass: this.compass.dump(), actorId: this.actorId };
    const text = JSON.stringify(data);
    this.saving = this.saving.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, this.file);
    });
    return this.saving;
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
      // The evaluation worker and outbox run right after each mutation.
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
