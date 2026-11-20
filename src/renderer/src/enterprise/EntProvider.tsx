import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { EntMethod, EntResponse, SessionInfo } from "@shared/enterprise/api-types";
import { EntCallError, EntContext, newKey } from "./client";

export function EntProvider({ me, onSignOut, children }: { me: SessionInfo["identities"][number]; onSignOut(): void; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [currency, setCurrency] = useState("USD");
  const call = useCallback(
    async <T,>(method: EntMethod, path: string, body?: unknown, opts: { ifRevision?: number; idempotent?: boolean } = {}): Promise<T> => {
      const res: EntResponse = await window.archymedes.entRequest({
        method,
        path: `/v1/workspaces/${me.workspaceId}${path}`,
        ...(body === undefined ? {} : { body }),
        ...(opts.ifRevision === undefined ? {} : { ifRevision: opts.ifRevision }),
        ...(method !== "GET" && opts.idempotent !== false ? { idempotencyKey: newKey() } : {}),
      });
      if (res.status >= 400) {
        const err = (res.body as { error?: { code: string; message: string } }).error;
        throw new EntCallError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status})`);
      }
      if (method !== "GET") setVersion((v) => v + 1);
      return res.body as T;
    },
    [me.workspaceId],
  );
  return <EntContext.Provider value={{ workspaceId: me.workspaceId, me, currency, version, call, signOut: onSignOut, setCurrency }}>{children}</EntContext.Provider>;
}

