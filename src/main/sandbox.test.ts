import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer runs sandboxed. A sandboxed preload can only `require` a small set of modules, so
 * this pins both halves: the window turns the sandbox on, and the preload stays within that set.
 */
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// Electron modules a sandboxed preload may use (https://www.electronjs.org/docs/latest/tutorial/sandbox).
const SANDBOX_ELECTRON_APIS = new Set(["contextBridge", "crashReporter", "ipcRenderer", "nativeImage", "webFrame", "webUtils"]);

describe("renderer sandbox", () => {
  it("creates the main window with the sandbox on", () => {
    const main = read("src/main/index.ts");
    expect(main).toMatch(/sandbox:\s*true/);
    expect(main).not.toMatch(/sandbox:\s*false/);
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
  });

  it("keeps the preload to modules a sandboxed preload can load", () => {
    const preload = read("src/preload/index.ts");
    const imports = [...preload.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, typeOnly, names, from] of imports) {
      if (typeOnly) continue; // erased at build time
      expect(from).toBe("electron");
      for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) {
        expect(SANDBOX_ELECTRON_APIS.has(name), `${name} is not available in a sandboxed preload`).toBe(true);
      }
    }
    expect(preload).not.toMatch(/\brequire\(/);
    expect(preload).not.toMatch(/^import\s+[^{t]/m); // no default/namespace imports of node modules
  });
});
