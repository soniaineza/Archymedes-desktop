import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Some security tests exercise the workspace boundary through symlinks.
 * Creating *directory* symlinks requires developer/admin privileges on
 * Windows, so instead of failing everywhere they're run locally, we probe
 * once and skip when the OS refuses. CI (Linux) always has the privilege.
 */

let canSymlink: boolean | null = null;

export async function supportsSymlinks(): Promise<boolean> {
  if (canSymlink !== null) return canSymlink;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arch-link-probe-"));
  try {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "arch-link-target-"));
    try {
      await fs.symlink(target, path.join(dir, "probe"), "dir");
      canSymlink = true;
    } catch {
      canSymlink = false;
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return canSymlink;
}

/**
 * Links a directory, on every platform and without privileges.
 *
 * Windows needs Developer Mode for a symlink but not for a junction — so a junction is the link an
 * attacker there can actually plant, and the boundary tests that link a *directory* use one rather
 * than skip. Only the tests that link a single file still need {@link supportsSymlinks}.
 */
export async function linkDirectory(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
