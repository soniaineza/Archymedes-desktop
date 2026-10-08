import { createAdapter } from "./agent/adapters";
import { CommandApprovals } from "./agent/approvals";
import { AgentRunController } from "./agent/run-controller";
import { AgentRunner } from "./agent/runner";
import type { AdapterFactory } from "./agent/runner";
import { WorkspaceSession } from "./services/workspace-session";
import { SnapshotStore } from "./snapshots";
import { TerminalManager } from "./terminal";
import { DailyUsageStore } from "./usage-store";
import { WorkspaceWatcher } from "./watcher";
import { modelCacheFile, ModelListService } from "./models";
import { KeyInfoService } from "./openrouter-key";

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
  /** Pending shell-command approvals, answered from the renderer. */
  readonly approvals: Pick<CommandApprovals, "resolve" | "denyAll">;
  readonly watcher: Pick<WorkspaceWatcher, "start" | "stop">;
  readonly terminals: Pick<TerminalManager, "create" | "write" | "resize" | "kill" | "onExit" | "disposeAll">;
  /** Today's token count (and the free gateway's allowance), persisted under userData. */
  readonly usage: Pick<DailyUsageStore, "snapshot" | "record">;
  /** Known + live model lists for the Settings picker, cached 6h under userData. */
  readonly models: Pick<ModelListService, "list">;
  /** OpenRouter's view of the user's own key (free-model requests left today), cached a minute. */
  readonly keyInfo: Pick<KeyInfoService, "get" | "noteRequest" | "clear">;
  /** Cancels the agent run, stops watching and kills every shell. Safe to call more than once. */
  dispose(): void;
}

export type ServiceOverrides = Partial<Pick<AppServices, "workspace" | "agent" | "watcher" | "terminals" | "models" | "keyInfo">> & {
  /** Swap the model for a scripted one while keeping the real tool loop. */
  createAdapter?: AdapterFactory;
};

export function createServices(paths: AppPaths, overrides: ServiceOverrides = {}): AppServices {
  const workspace = overrides.workspace ?? new WorkspaceSession();
  const snapshots = new SnapshotStore(paths.userData);
  const approvals = new CommandApprovals();
  const usage = new DailyUsageStore(paths.userData);
  const keyInfo = overrides.keyInfo ?? new KeyInfoService();
  const agent =
    overrides.agent ??
    new AgentRunController(
      (settings, root, emit) =>
        new AgentRunner(settings, root, emit, {
          createAdapter: overrides.createAdapter ?? createAdapter,
          recordSnapshot: (workspaceRoot, relPath) => snapshots.recordBefore(workspaceRoot, relPath),
          approveCommand: (call, signal) => approvals.request({ ...call, workspace: root, emit, signal }),
          recordUsage: (tokens, allowance) => {
            // A completed free request with the user's own key comes off OpenRouter's daily count.
            if (tokens > 0 && settings.provider === "free" && settings.apiKey.trim()) keyInfo.noteRequest(settings.apiKey);
            return usage.record(tokens, allowance);
          },
        }),
    );
  const watcher = overrides.watcher ?? new WorkspaceWatcher();
  const terminals = overrides.terminals ?? new TerminalManager();
  const models = overrides.models ?? new ModelListService({ cacheFile: modelCacheFile(paths.userData) });

  return {
    paths,
    workspace,
    snapshots,
    agent,
    approvals,
    watcher,
    terminals,
    usage,
    models,
    keyInfo,
    dispose() {
      agent.cancel();
      approvals.denyAll();
      watcher.stop();
      terminals.disposeAll();
    },
  };
}
