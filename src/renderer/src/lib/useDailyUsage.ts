import { useEffect, useState } from "react";
import type { DailyUsage } from "@shared/types";

/**
 * Today's token count (and, in free mode, the requests left) from the main process: fetched on mount, after each run settles (the
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
      // A per-request push carries no key info; keep the last lookup until the next refresh.
      if (event.type === "daily-usage") setDaily((previous) => ({ ...event.usage, keyInfo: event.usage.keyInfo ?? previous?.keyInfo }));
    });
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      unsubscribe();
    };
  }, [refreshKey]);

  return daily;
}
