import { useEffect, useState } from "react";
import type { DailyUsage } from "@shared/types";

/**
 * Today's token count from the main process: fetched on mount, after each run settles (the
 * settings, and so the provider, may have changed) and when the window regains focus (the UTC day
 * may have rolled over), and pushed live with each model request as a daily-usage event.
 */
export function useDailyUsage(refreshKey: unknown): DailyUsage | null {
  const [daily, setDaily] = useState<DailyUsage | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      window.archymedes.getDailyUsage().then(
        (usage) => {
          if (live) setDaily(usage);
        },
        () => undefined,
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    const unsubscribe = window.archymedes.onAgentEvent((event) => {
      if (event.type === "daily-usage") setDaily(event.usage);
    });
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      unsubscribe();
    };
  }, [refreshKey]);

  return daily;
}
