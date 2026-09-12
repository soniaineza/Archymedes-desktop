import { describe, expect, it } from "vitest";
import { AppError, parseAppError, toTransportError } from "./app-error";

/** What the renderer actually receives after Electron rejects an invoke. */
function acrossIpc(error: unknown, channel = "agent:send"): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${toTransportError(error).message}`);
}

describe("app errors across IPC", () => {
  it("keeps the code, message and params of an AppError", () => {
    const received = acrossIpc(new AppError("iteration-limit", "Reached the limit", { count: 40 }));
    expect(parseAppError(received)).toEqual({ code: "iteration-limit", message: "Reached the limit", params: { count: 40 } });
  });

  it("strips Electron's wrapper from ordinary errors", () => {
    expect(parseAppError(acrossIpc(new Error("disk full")))).toEqual({ message: "disk full" });
  });

  it("handles non-Error throws", () => {
    expect(parseAppError(acrossIpc("boom"))).toEqual({ message: "boom" });
    expect(parseAppError(42)).toEqual({ message: "42" });
  });

  it("survives a message that merely mentions the tag", () => {
    const fake = new Error("ARCHYMEDES_APP_ERROR:{not json");
    expect(parseAppError(fake).code).toBeUndefined();
  });

  it("rejects payloads with an unknown code", () => {
    const forged = new Error('ARCHYMEDES_APP_ERROR:{"code":"root-shell","message":"x"}');
    expect(parseAppError(forged).code).toBeUndefined();
  });

  it("passes ordinary errors through untouched", () => {
    const original = new Error("plain");
    expect(toTransportError(original)).toBe(original);
  });
});
