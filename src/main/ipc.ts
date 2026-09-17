import { AppError } from "../shared/app-error";
import { PROVIDER_INFO } from "../shared/providers";
import { listDirTree, readFileForEditor, writeFileFromEditor } from "./fs-ui";
import { getGitInfo } from "./git";
import { registerHandlers } from "./ipc-host";
import type { HostBridge, IpcHost } from "./ipc-host";
import { workspaceSearch } from "./search";
import { workspaceSymbols } from "./symbols";
import type { AppServices } from "./services";
import { deleteSession, listSessions, loadSession, renameSession, saveSession } from "./sessions";
import { loadSettings, saveSettings } from "./settings";
import { isTerminalShellChoice } from "../shared/types";

/**
 * Every IPC handler. The renderer can only do what is exposed here through the
 * preload bridge. Nothing in this module touches Electron directly: the host,
 * the services and the bridge are all passed in.
 */
export function registerIpc(host: IpcHost, services: AppServices, bridge: HostBridge): void {
  const { workspace, agent, watcher, terminals } = services;
  const { userData } = services.paths;

  const switchWorkspace = (next: string | null): void => {
    if (!workspace.setRoot(next)) return;
    // A run must never keep writing into a workspace the user has left.
    agent.cancel();
    watcher.stop(); // re-started by the renderer for the new workspace
  };

  registerHandlers(
    host,
    {
      // ---------- workspace / fs ----------
      "fs:pick-workspace": async (dialogTitle) => {
        const picked = await bridge.pickDirectory(dialogTitle?.trim() ? dialogTitle.slice(0, 200) : "Choose a workspace folder");
        if (picked === null) return null;
        switchWorkspace(picked);
        return workspace.root;
      },
      "fs:get-workspace": () => workspace.root,
      "fs:set-workspace": (path) => switchWorkspace(path),
      "fs:list-tree": (relPath) => listDirTree(workspace.requireRoot(), relPath),
      "fs:read-file": (relPath) => readFileForEditor(workspace.requireRoot(), relPath),
      "fs:write-file": (relPath, content) => writeFileFromEditor(workspace.requireRoot(), relPath, content),

      // ---------- settings ----------
      "settings:get": () => loadSettings(userData),
      "settings:save": (settings) => saveSettings(userData, settings),

      // ---------- agent ----------
      "agent:send": async (history) => {
        const root = workspace.requireRoot();
        const settings = await loadSettings(userData);
        if (!settings.apiKey && PROVIDER_INFO[settings.provider]?.requiresApiKey !== false) {
          throw new AppError("no-api-key", `No API key configured for ${settings.provider}`);
        }
        await agent.start(settings, root, history, (event) => bridge.emit("agent:event", event));
      },
      "agent:cancel": () => agent.cancel(),
      "agent:approve": (requestId, decision) => services.approvals.resolve(requestId, decision),

      // ---------- git / search ----------
      "git:get-info": () => (workspace.root ? getGitInfo(workspace.root) : { isRepo: false, branch: "", dirtyCount: 0 }),
      "search:workspace": (query, caseSensitive) => workspaceSearch(workspace.requireRoot(), query, caseSensitive),
      "symbols:workspace": (query) => workspaceSymbols(workspace.requireRoot(), query),

      // ---------- sessions ----------
      "session:list": () => listSessions(userData),
      "session:load": (id) => loadSession(userData, id),
      "session:save": (session) => saveSession(userData, session),
      "session:delete": (id) => deleteSession(userData, id),
      "session:rename": (id, title) => renameSession(userData, id, title),

      // ---------- diffs / revert ----------
      "diff:file": (relPath) => services.snapshots.diff(workspace.requireRoot(), relPath),
      "diff:revert": async (relPath) => {
        await services.snapshots.revert(workspace.requireRoot(), relPath);
        bridge.emit("watch:event", { changed: true });
      },
      "diff:list-edits": () => (workspace.root ? services.snapshots.listEdits(workspace.root) : []),

      // ---------- watcher ----------
      "watch:start": () => {
        if (workspace.root) watcher.start(workspace.root, () => bridge.emit("watch:event", { changed: true }));
      },
      "watch:stop": () => watcher.stop(),

      // ---------- terminal ----------
      "term:create": async (cwd, shellOverride) => {
        // The saved setting is the default; the renderer's per-tab dropdown overrides it.
        const settings = await loadSettings(userData);
        const shellRequest =
          shellOverride && isTerminalShellChoice(shellOverride)
            ? { choice: shellOverride, customPath: settings.terminalShellPath }
            : { choice: settings.terminalShell, customPath: settings.terminalShellPath };
        const session = await terminals.create(cwd ?? workspace.root ?? undefined, shellRequest);
        session.pty.onData((data) => bridge.emit("term:data", session.id, data));
        session.pty.onExit(({ exitCode }) => {
          bridge.emit("term:exit", session.id, exitCode);
          terminals.onExit(session.id);
        });
        return { id: session.id, cwd: session.cwd, shellLabel: session.shellLabel, warning: session.warning };
      },
    },
    {
      "term:write": (id, data) => terminals.write(id, data),
      "term:resize": (id, cols, rows) => terminals.resize(id, cols, rows),
      "term:kill": (id) => terminals.kill(id),
    },
  );
}
