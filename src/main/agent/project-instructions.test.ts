import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_SETTINGS, type AgentEvent } from "../../shared/types";
import { instructionsSection, loadProjectInstructions } from "./project-instructions";
import { AgentRunner } from "./runner";
import { createScriptedAdapter } from "./scripted-adapter";

let repo: string;
beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "arch-instructions-"));
  await fs.mkdir(path.join(repo, ".git"));
  await fs.mkdir(path.join(repo, "packages", "api"), { recursive: true });
});
afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }); });

describe("project instructions", () => {
  it("reads one file per directory from the git root down, broad to specific", async () => {
    await fs.writeFile(path.join(repo, "AGENTS.md"), "Use pnpm.");
    await fs.writeFile(path.join(repo, "CLAUDE.md"), "ignored: AGENTS.md comes first");
    await fs.writeFile(path.join(repo, "packages", "api", "ARCHYMEDES.md"), "Use snake_case fields.");
    const loaded = await loadProjectInstructions(path.join(repo, "packages", "api"));
    expect(loaded?.sources).toEqual(["AGENTS.md", "packages/api/ARCHYMEDES.md"]);
    expect(loaded?.text).toBe("[AGENTS.md]\nUse pnpm.\n\n[packages/api/ARCHYMEDES.md]\nUse snake_case fields.");
    expect(instructionsSection(loaded)).toContain("take precedence over your general habits");
  });

  it("gives the deeper file the budget and returns nothing when there are no files", async () => {
    expect(await loadProjectInstructions(repo)).toBeNull();
    await fs.writeFile(path.join(repo, "AGENTS.md"), "x".repeat(9_000));
    await fs.writeFile(path.join(repo, "packages", "api", "AGENTS.md"), "deep rule");
    const loaded = await loadProjectInstructions(path.join(repo, "packages", "api"));
    expect(loaded?.text.endsWith("deep rule")).toBe(true);
    expect(loaded!.text.length).toBeLessThan(8_100);
  });

  it("reaches the model's system prompt on a run", async () => {
    await fs.writeFile(path.join(repo, "AGENTS.md"), "Never use npm.");
    let seen = "";
    const scripted = createScriptedAdapter([{ text: "ok" }]);
    const adapter = { ...scripted, runTurn: (input: Parameters<typeof scripted.runTurn>[0]) => { seen = input.systemPrompt; return scripted.runTurn(input); } };
    const events: AgentEvent[] = [];
    await new AgentRunner({ ...DEFAULT_PROVIDER_SETTINGS, maxIterations: 2 }, repo, (e) => events.push(e), {
      createAdapter: () => adapter,
      recordSnapshot: async () => {},
    }).run([{ id: "u", role: "user", content: "hi" }]);
    expect(seen).toContain("Project instructions from AGENTS.md");
    expect(seen).toContain("Never use npm.");
  });
});
