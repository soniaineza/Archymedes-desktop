import path from "node:path";
import { AppError } from "../../shared/app-error";

/** The open workspace. One instance, passed explicitly to whatever needs the root. */
export class WorkspaceSession {
  private current: string | null = null;

  get root(): string | null {
    return this.current;
  }

  /** Returns true when the root actually changed, so callers can tear down work tied to the old one. */
  setRoot(next: string | null): boolean {
    const normalized = next === null ? null : path.resolve(next);
    if (normalized === this.current) return false;
    this.current = normalized;
    return true;
  }

  requireRoot(): string {
    if (this.current === null) throw new AppError("no-workspace", "No workspace is open");
    return this.current;
  }
}
