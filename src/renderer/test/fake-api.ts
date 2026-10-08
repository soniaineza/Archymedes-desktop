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
    listModels: vi.fn(async (request) => ({ provider: request.provider, known: [], live: [], status: "unsupported" as const })),

    sendAgentMessage: vi.fn(async () => {}),
    cancelAgent: vi.fn(async () => {}),
    approveCommand: vi.fn(async () => {}),
    getDailyUsage: vi.fn(async () => ({ date: "2026-10-08", tokens: 0, provider: DEFAULT_PROVIDER_SETTINGS.provider })),
    checkFreeKey: vi.fn(async () => ({ ok: true as const, info: { isFreeTier: true, dailyRequestLimit: 50 } })),
    isFreeReady: vi.fn(async () => true),
    openExternal: vi.fn(async () => {}),
    onAgentEvent: (handler) => {
      agentListeners.add(handler);
      return () => {
        agentListeners.delete(handler);
      };
    },

    getGitInfo: vi.fn(async () => ({ isRepo: false, branch: "", dirtyCount: 0 })),
    workspaceSearch: vi.fn(async () => ({ truncated: false, hits: [] })),
    workspaceSymbols: vi.fn(async () => ({ hits: [], truncated: false })),

    listSessions: vi.fn(async () => []),
    loadSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    deleteAllSessions: vi.fn(async () => 0),
    renameSession: vi.fn(async () => {}),
    listLegacySessions: vi.fn(async () => ({ count: 0, ids: [] })),
    adoptLegacySessions: vi.fn(async () => 0),

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
    terminalKill: vi.fn(),
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
