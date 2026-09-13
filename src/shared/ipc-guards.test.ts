import { describe, expect, it } from "vitest";
import { AppError } from "./app-error";
import { chatHistory, INVOKE_GUARDS, providerSettings, SEND_GUARDS, sessionData } from "./ipc-guards";
import { DEFAULT_PROVIDER_SETTINGS } from "./types";

function invalidArgument(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("invalid-argument");
    return error as AppError;
  }
  throw new Error("expected an invalid-argument error");
}

describe("provider settings guard", () => {
  it("accepts valid settings", () => {
    expect(providerSettings(DEFAULT_PROVIDER_SETTINGS, "settings")).toEqual(DEFAULT_PROVIDER_SETTINGS);
  });

  it("strips fields the app doesn't know about", () => {
    const withExtra = { ...DEFAULT_PROVIDER_SETTINGS, __proto_pollution: true, shell: "rm -rf /" };
    expect(Object.keys(providerSettings(withExtra, "settings")).sort()).toEqual(Object.keys(DEFAULT_PROVIDER_SETTINGS).sort());
  });

  it("rejects an unknown provider", () => {
    invalidArgument(() => providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, provider: "evil" }, "settings"));
  });

  it("rejects out-of-range iterations and malformed currency", () => {
    invalidArgument(() => providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, maxIterations: 0 }, "settings"));
    invalidArgument(() => providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, maxIterations: 2.5 }, "settings"));
    invalidArgument(() => providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, currency: "usd" }, "settings"));
    invalidArgument(() => providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, exchangeRate: -1 }, "settings"));
  });

  it("names the offending field", () => {
    const error = invalidArgument(() => providerSettings({ ...DEFAULT_PROVIDER_SETTINGS, apiKey: 7 }, "settings"));
    expect(error.message).toContain("settings.apiKey");
  });
});

describe("chat history guard", () => {
  const message = { id: "m1", role: "assistant", content: "hi", toolCalls: [{ id: "t1", name: "read_file", args: "{}", result: "ok" }] };

  it("accepts well-formed messages and keeps tool calls", () => {
    expect(chatHistory([message], "history")).toEqual([message]);
  });

  it("drops UI-only fields such as pending and queued", () => {
    const [clean] = chatHistory([{ ...message, pending: true, queued: true }], "history");
    expect(clean).not.toHaveProperty("pending");
    expect(clean).not.toHaveProperty("queued");
  });

  it("rejects unknown roles and non-string content", () => {
    invalidArgument(() => chatHistory([{ ...message, role: "tool" }], "history"));
    invalidArgument(() => chatHistory([{ ...message, content: null }], "history"));
    invalidArgument(() => chatHistory("not a list", "history"));
  });
});

describe("session guard", () => {
  it("requires an id and numeric timestamps", () => {
    const valid = { id: "s1", title: "", createdAt: 1, updatedAt: 2, messages: [] };
    expect(sessionData(valid, "session")).toEqual(valid);
    invalidArgument(() => sessionData({ ...valid, id: "" }, "session"));
    invalidArgument(() => sessionData({ ...valid, updatedAt: "yesterday" }, "session"));
  });
});

describe("channel guards", () => {
  it("rejects paths containing NUL bytes", () => {
    invalidArgument(() => INVOKE_GUARDS["fs:read-file"](["a\u0000b"]));
  });

  it("accepts paths with spaces and non-Latin characters", () => {
    expect(INVOKE_GUARDS["fs:read-file"](["my docs/résumé ملف.md"])).toEqual(["my docs/résumé ملف.md"]);
  });

  it("rejects extra arguments on argument-less channels", () => {
    invalidArgument(() => INVOKE_GUARDS["session:list"](["unexpected"]));
  });

  it("defaults the tree root to the workspace root", () => {
    expect(INVOKE_GUARDS["fs:list-tree"]([])).toEqual([""]);
  });

  it("bounds terminal resize to sane integers", () => {
    expect(SEND_GUARDS["term:resize"](["term-1", 80, 24])).toEqual(["term-1", 80, 24]);
    invalidArgument(() => SEND_GUARDS["term:resize"](["term-1", 0, 24]));
    invalidArgument(() => SEND_GUARDS["term:resize"](["term-1", 80, Number.NaN]));
  });
});
