/**
 * Compile-time guarantees of the IPC contract, checked by `npm run typecheck`.
 * Each line must fail to compile; if the contract ever stops rejecting one,
 * the unused @ts-expect-error directive itself becomes the error.
 */

import type { InvokeHandlers, SendHandlers } from "./ipc-host";

// @ts-expect-error: a handler returning the wrong type must not compile
export const wrongResult: Pick<InvokeHandlers, "fs:get-workspace"> = { "fs:get-workspace": () => 42 };

// @ts-expect-error: a handler taking the wrong argument types must not compile
export const wrongArgs: Pick<InvokeHandlers, "fs:read-file"> = { "fs:read-file": (relPath: number) => relPath };

// @ts-expect-error: terminal creation promises a cwd, not just an id
export const missingField: InvokeHandlers["term:create"] = () => ({ id: "term-1" });

// @ts-expect-error: every invoke channel needs a handler
export const missingHandler: InvokeHandlers = {};

// @ts-expect-error: every send channel needs a listener
export const missingListener: SendHandlers = { "term:write": () => {} };
