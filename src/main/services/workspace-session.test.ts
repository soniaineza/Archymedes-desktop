import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../../shared/app-error";
import { WorkspaceSession } from "./workspace-session";

describe("WorkspaceSession", () => {
  it("starts with no workspace", () => {
    const session = new WorkspaceSession();
    expect(session.root).toBeNull();
    expect(() => session.requireRoot()).toThrow(AppError);
  });

  it("reports whether the root actually changed", () => {
    const session = new WorkspaceSession();
    const dir = path.resolve("/tmp/project");
    expect(session.setRoot(dir)).toBe(true);
    expect(session.setRoot(`${dir}/./`)).toBe(false);
    expect(session.setRoot(null)).toBe(true);
    expect(session.setRoot(null)).toBe(false);
  });

  it("uses the no-workspace code so the renderer can translate it", () => {
    try {
      new WorkspaceSession().requireRoot();
    } catch (error) {
      expect((error as AppError).code).toBe("no-workspace");
    }
  });
});
