import { createAdapter } from "./agent/adapters";
import { AgentRunController } from "./agent/run-controller";
import { AgentRunner } from "./agent/runner";
import type { AdapterFactory } from "./agent/runner";
import { WorkspaceSession } from "./services/workspace-session";
import { SnapshotStore } from "./snapshots";
import { TerminalManager } from "./terminal";
import { WorkspaceWatcher } from "./watcher";

export interface AppPaths {
  userData: string;
}

/**
 * Everything the main process owns, created once at startup and handed to the
 * IPC layer explicitly. Tests build it with fakes in place of shells, watchers
 * and the model.
 */
export interface AppServices {
  readonly paths: AppPaths;
  readonly workspace: WorkspaceSession;
  readonly snapshots: SnapshotStore;
  readonly agent: Pick<AgentRunController, "start" | "cancel">;
  readonly watcher: Pick<WorkspaceWatcher, "start" | "stop">;
  readonly terminals: Pick<TerminalManager, "create" | "write" | "resize" | "onExit" | "disposeAll">;
  /** Cancels the agent run, stops watching and kills every shell. Safe to call more than once. */
  dispose(): void;
}

export type ServiceOverrides = Partial<Pick<AppServices, "workspace" | "agent" | "watcher" | "terminals">> & {
  /** Swap the model for a scripted one while keeping the real tool loop. */
  createAdapter?: AdapterFactory;
};

export function createServices(paths: AppPaths, overrides: ServiceOverrides = {}): AppServices {
  const workspace = overrides.workspace ?? new WorkspaceSession();
  const snapshots = new SnapshotStore(paths.userData);
  const agent =
    overrides.agent ??
    new AgentRunController(
      (settings, root, emit) =>
        new AgentRunner(settings, root, emit, {
          createAdapter: overrides.createAdapter ?? createAdapter,
          recordSnapshot: (workspaceRoot, relPath) => snapshots.recordBefore(workspaceRoot, relPath),
        }),
    );
  const watcher = overrides.watcher ?? new WorkspaceWatcher();
  const terminals = overrides.terminals ?? new TerminalManager();

  return {
    paths,
    workspace,
    snapshots,
    agent,
    watcher,
    terminals,
    dispose() {
      agent.cancel();
      watcher.stop();
      terminals.disposeAll();
    },
  };
}
