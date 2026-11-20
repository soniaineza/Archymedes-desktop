import type { ArchymedesApi } from "@shared/types";
import { EnterpriseHost } from "../../../main/enterprise/host";
import type { Persisted } from "../../../main/enterprise/host";

export const WEB_STATE_KEY = "archymedes.web.state.v1";

type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type WebBridge = Pick<ArchymedesApi, "entRequest" | "entSession" | "entSignIn" | "entCreateWorkspace" | "entReset">;

/**
 * The web edition's stand-in for the Electron preload: the same Enterprise API
 * running in the page, with each visitor's workspace kept in their own browser.
 * Nothing is sent to a server.
 */
export function createWebBridge(storage: KeyValue, now?: () => string): WebBridge {
  const host = new EnterpriseHost(
    {
      async load() {
        const raw = storage.getItem(WEB_STATE_KEY);
        return raw ? (JSON.parse(raw) as Persisted) : null;
      },
      async save(data) {
        try {
          storage.setItem(WEB_STATE_KEY, JSON.stringify(data));
        } catch {
          // Quota or private mode: the session still works, it just won't survive a reload.
        }
      },
    },
    { now },
  );
  return {
    entRequest: (req) => host.request(structuredClone(req)),
    entSession: () => host.session(),
    entSignIn: (id) => host.signIn(id),
    entCreateWorkspace: (input) => host.createWorkspace(structuredClone(input)),
    entReset: () => host.resetAll(),
  };
}
