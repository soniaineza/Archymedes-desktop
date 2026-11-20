import type { CompassTask } from "../../shared/enterprise/api-types";

export interface CreateTaskInput {
  projectId: string;
  actionId: string;
  title: string;
  doneWhen: string[];
  assignee: string;
}

/**
 * The Compass work boundary (spec §3). Tasks carry the external action ID so a
 * timed-out write can be reconciled before retrying. Exact schemas, auth and
 * workspace isolation of the live Compass service are verified in Phase 0;
 * until then a tenant uses the isolated local implementation below.
 */
export interface CompassAdapter {
  readonly kind: "local" | "remote";
  findTaskByActionId(workspace: string, actionId: string): Promise<CompassTask | null>;
  createTask(workspace: string, input: CreateTaskInput): Promise<CompassTask>;
  listTasks(workspace: string): Promise<CompassTask[]>;
}

export class CompassTimeout extends Error {
  constructor() {
    super("Compass did not answer in time");
  }
}

/** Isolated per-workspace work store with Compass-style IDs. */
export class LocalCompassAdapter implements CompassAdapter {
  readonly kind = "local" as const;
  private failure: "timeout_after_write" | "timeout_before_write" | null = null;

  constructor(
    private readonly tasks: CompassTask[] = [],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Test hook: the next create times out, either before or after it lands. */
  failNext(kind: "timeout_after_write" | "timeout_before_write"): void {
    this.failure = kind;
  }

  taskCount(workspace: string): number {
    return this.tasks.filter((t) => t.workspace === workspace).length;
  }

  dump(): CompassTask[] {
    return structuredClone(this.tasks);
  }

  async findTaskByActionId(workspace: string, actionId: string): Promise<CompassTask | null> {
    return this.tasks.find((t) => t.workspace === workspace && t.actionId === actionId) ?? null;
  }

  async listTasks(workspace: string): Promise<CompassTask[]> {
    return this.tasks.filter((t) => t.workspace === workspace);
  }

  async createTask(workspace: string, input: CreateTaskInput): Promise<CompassTask> {
    const failure = this.failure;
    this.failure = null;
    if (failure === "timeout_before_write") throw new CompassTimeout();
    const existing = await this.findTaskByActionId(workspace, input.actionId);
    const task =
      existing ??
      ({ id: `CMP-${String(101 + this.tasks.length).padStart(4, "0")}`, workspace, status: "todo", createdAt: this.now(), ...input } satisfies CompassTask);
    if (!existing) this.tasks.push(task);
    if (failure === "timeout_after_write") throw new CompassTimeout();
    return task;
  }
}
