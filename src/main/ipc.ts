import { AppError } from "../shared/app-error";
import { PROVIDER_INFO } from "../shared/providers";
import { listDirTree, readFileForEditor, writeFileFromEditor } from "./fs-ui";
import { getGitInfo } from "./git";
import { registerHandlers } from "./ipc-host";
import type { HostBridge, IpcHost } from "./ipc-host";
import { workspaceSearch } from "./search";
import type { AppServices } from "./services";
import { deleteSession, listSessions, loadSession, renameSession, saveSession } from "./sessions";
import { loadSettings, saveSettings } from "./settings";

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

      // ---------- git / search ----------
      "git:get-info": () => (workspace.root ? getGitInfo(workspace.root) : { isRepo: false, branch: "", dirtyCount: 0 }),
      "search:workspace": (query) => workspaceSearch(workspace.requireRoot(), query),

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
      "term:create": (cwd) => {
        const session = terminals.create(cwd ?? workspace.root ?? undefined);
        session.pty.onData((data) => bridge.emit("term:data", session.id, data));
        session.pty.onExit(({ exitCode }) => {
          bridge.emit("term:exit", session.id, exitCode);
          terminals.onExit(session.id);
        });
        return { id: session.id, cwd: session.cwd };
      },
    },
    {
      "term:write": (id, data) => terminals.write(id, data),
      "term:resize": (id, cols, rows) => terminals.resize(id, cols, rows),
    },
  );
}
