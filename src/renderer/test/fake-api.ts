import { vi } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS } from "@shared/types";
import type { AgentEvent, ArchymedesApi } from "@shared/types";

export type FakeApi = ArchymedesApi & {
  /** Push an event as if the main process sent it. */
  emitAgentEvent(event: AgentEvent): void;
  emitWatchEvent(): void;
};

/**
 * An in-memory `window.archymedes`. Typed as the real contract, so it stops
 * compiling the moment the preload API and this fake disagree.
 */
export function createFakeApi(overrides: Partial<ArchymedesApi> = {}): FakeApi {
  const agentListeners = new Set<(event: AgentEvent) => void>();
  const watchListeners = new Set<(event: { changed: boolean }) => void>();

  const api: ArchymedesApi = {
    setZoomFactor: vi.fn(),

    pickWorkspace: vi.fn(async () => null),
    getWorkspace: vi.fn(async () => null),
    setWorkspace: vi.fn(async () => {}),
    listDirTree: vi.fn(async () => []),
    readFile: vi.fn(async (relPath: string) => ({ path: relPath, content: "", truncated: false })),
    writeFile: vi.fn(async () => {}),

    getSettings: vi.fn(async () => ({ ...DEFAULT_PROVIDER_SETTINGS })),
    saveSettings: vi.fn(async () => {}),

    sendAgentMessage: vi.fn(async () => {}),
    cancelAgent: vi.fn(async () => {}),
    onAgentEvent: (handler) => {
      agentListeners.add(handler);
      return () => {
        agentListeners.delete(handler);
      };
    },

    getGitInfo: vi.fn(async () => ({ isRepo: false, branch: "", dirtyCount: 0 })),
    workspaceSearch: vi.fn(async () => ({ truncated: false, hits: [] })),

    listSessions: vi.fn(async () => []),
    loadSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),

    diffFile: vi.fn(async () => null),
    revertFile: vi.fn(async () => {}),
    listEdits: vi.fn(async () => []),

    startWatching: vi.fn(async () => {}),
    stopWatching: vi.fn(async () => {}),
    onWatchEvent: (handler) => {
      watchListeners.add(handler);
      return () => {
        watchListeners.delete(handler);
      };
    },

    createTerminal: vi.fn(async (cwd?: string) => ({ id: "term-1", cwd: cwd ?? "/" })),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},

    ...overrides,
  };

  return Object.assign(api, {
    emitAgentEvent: (event: AgentEvent) => agentListeners.forEach((listener) => listener(event)),
    emitWatchEvent: () => watchListeners.forEach((listener) => listener({ changed: true })),
  });
}

/** The fake installed for the current test by setup.ts. */
export function fakeApi(): FakeApi {
  return window.archymedes as FakeApi;
}
