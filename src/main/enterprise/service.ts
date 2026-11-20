import { promises as fs } from "node:fs";
import path from "node:path";
import { EnterpriseHost } from "./host";
import type { Persisted, PersistStore } from "./host";

/** Atomic JSON file under userData; writes are serialized (temp file + rename). */
function fileStore(file: string): PersistStore {
  let saving: Promise<void> = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await fs.readFile(file, "utf8")) as Persisted;
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      saving = saving.then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, text, "utf8");
        await fs.rename(tmp, file);
      });
      return saving;
    },
  };
}

/**
 * The desktop's local pilot backend: EnterpriseHost over a JSON file in
 * userData. In a hosted deployment this is replaced by an HTTP client with
 * OIDC tokens held in the OS keychain; the request/response contract is the same.
 */
export class EnterpriseService extends EnterpriseHost {
  constructor(userData: string, opts: { now?: () => string } = {}) {
    super(fileStore(path.join(userData, "enterprise", "state.json")), opts);
  }
}
