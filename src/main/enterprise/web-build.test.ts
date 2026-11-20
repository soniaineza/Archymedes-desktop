import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

describe("web edition build (vite.web.config.ts → Vercel static output)", () => {
  it("emits index.html, hashed assets and the Vercel config, with no Node-only code", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "web-build-"));
    try {
      await build({ configFile: path.join(root, "vite.web.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
      const html = await fs.readFile(path.join(outDir, "index.html"), "utf8");
      expect(html).toContain("<title>Archymedes OS</title>");
      expect(html).toMatch(/Content-Security-Policy/);
      const script = /src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(script).toBeTruthy();
      const js = await fs.readFile(path.join(outDir, script!), "utf8");
      expect(js).not.toMatch(/node:(crypto|fs|path)/);
      expect(js).toContain("archymedes.web.state.v1");
      const vercel = JSON.parse(await fs.readFile(path.join(outDir, "vercel.json"), "utf8"));
      expect(vercel.headers[0].headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
