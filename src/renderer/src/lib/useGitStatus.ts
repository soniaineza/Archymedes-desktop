import { useEffect, useState } from "react";
import type { GitInfo } from "@shared/types";

/** Each poll spawns git, so it runs only while the window is visible and focused. */
export const GIT_POLL_MS = 10_000;

function windowActive(): boolean {
  return document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus());
}

/** Git state polled for the status bar; refreshed at once when the window comes back. */
export function useGitStatus(workspace: string | null): GitInfo {
  const [git, setGit] = useState<GitInfo>({ isRepo: false, branch: "", dirtyCount: 0 });
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = () => {
      void window.archymedes.getGitInfo().then((info) => {
        if (alive) setGit(info);
      });
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer !== null) return;
      poll();
      timer = setInterval(poll, GIT_POLL_MS);
    };
    const sync = () => (windowActive() ? start() : stop());

    // The first read happens even in the background so the status bar is never blank.
    poll();
    if (windowActive()) timer = setInterval(poll, GIT_POLL_MS);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, [workspace]);
  return git;
}
