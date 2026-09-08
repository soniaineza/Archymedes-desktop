import { execFile } from "node:child_process";
import type { GitInfo } from "../shared/types";

/**
 * Minimal git integration: branch name + dirty file count for the status bar.
 * Read-only; the agent's run_command tool is how deeper git work happens.
 */

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout?.toString() ?? "" });
    });
  });
}

export async function getGitInfo(workspace: string): Promise<GitInfo> {
  const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"], workspace);
  if (branchRes.code !== 0) {
    return { isRepo: false, branch: "", dirtyCount: 0 };
  }
  const statusRes = await git(["status", "--porcelain"], workspace);
  const dirtyCount = statusRes.out.split("\n").filter((l) => l.trim().length > 0).length;
  return { isRepo: true, branch: branchRes.out.trim(), dirtyCount };
}
