import type { IpcMain } from "electron";
import { toTransportError } from "../shared/app-error";
import type {
  EventChannel,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  IpcEventMap,
  IpcSendMap,
  SendChannel,
} from "../shared/ipc-contract";
import { INVOKE_GUARDS, SEND_GUARDS } from "../shared/ipc-guards";
import type { InvokeGuards, SendGuards } from "../shared/ipc-guards";

/** One handler per invoke channel. A missing or mistyped handler is a compile error. */
export type InvokeHandlers = {
  [K in InvokeChannel]: (...args: InvokeArgs<K>) => InvokeResult<K> | Promise<InvokeResult<K>>;
};

/** One listener per send channel. */
export type SendHandlers = {
  [K in SendChannel]: (...args: IpcSendMap[K]) => void;
};

export type EmitEvent = <K extends EventChannel>(channel: K, ...payload: IpcEventMap[K]) => void;

/** The few things the IPC layer needs from the windowing host; Electron in the app, a fake in tests. */
export interface HostBridge {
  /** Resolves to the chosen directory, or null when the user cancels. */
  pickDirectory(title: string): Promise<string | null>;
  emit: EmitEvent;
}

/** The slice of Electron's ipcMain the app uses; tests substitute an in-memory host. */
export interface IpcHost {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
}

export function electronIpcHost(ipcMain: IpcMain): IpcHost {
  return {
    handle: (channel, handler) => ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args)),
    on: (channel, listener) => {
      ipcMain.on(channel, (_event, ...args: unknown[]) => listener(...args));
    },
  };
}

type AnyHandler = (...args: unknown[]) => unknown;
type AnyGuard = (args: unknown[]) => unknown[];

/**
 * Registers every channel. Renderer arguments pass through that channel's guard
 * before reaching the handler, and errors are encoded so their codes survive IPC.
 */
export function registerHandlers(
  host: IpcHost,
  invoke: InvokeHandlers,
  send: SendHandlers,
  guards: { invoke: InvokeGuards; send: SendGuards } = { invoke: INVOKE_GUARDS, send: SEND_GUARDS },
): void {
  for (const channel of Object.keys(invoke) as InvokeChannel[]) {
    const handler = invoke[channel] as AnyHandler;
    const guard = guards.invoke[channel] as AnyGuard;
    host.handle(channel, async (...raw) => {
      try {
        return await handler(...guard(raw));
      } catch (error) {
        throw toTransportError(error);
      }
    });
  }

  for (const channel of Object.keys(send) as SendChannel[]) {
    const listener = send[channel] as AnyHandler;
    const guard = guards.send[channel] as AnyGuard;
    host.on(channel, (...raw) => {
      try {
        listener(...guard(raw));
      } catch (error) {
        // Fire-and-forget channels have no caller to reject; surface it in the main-process log.
        console.warn(`[ipc] dropped ${channel}:`, error instanceof Error ? error.message : error);
      }
    });
  }
}
