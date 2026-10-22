import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The project's own standing instructions, given to the model on every run.
 *
 * Ported from the CLI's `collectProjectContext`: the desktop agent ignored AGENTS.md entirely, so a
 * repository that told the CLI "use pnpm, never npm" got npm from the desktop app. Same file names
 * and precedence as the CLI: one file per directory (first match wins), gathered from the workspace
 * up to its git root, deeper files are more specific and get the character budget first.
 */

export const INSTRUCTION_FILES = ["AGENTS.override.md", "ARCHYMEDES.md", "AGENTS.md", "CLAUDE.md", ".archymedesrules"];
const MAX_INSTRUCTION_CHARS = 8_000;

export interface ProjectInstructions {
  /** Workspace-relative paths, broad to specific. */
  sources: string[];
  text: string;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

/** The git root above the workspace, or the workspace itself; never an unrelated repository above the temp directory. */
async function boundary(workspace: string): Promise<string> {
  const temporary = path.resolve(os.tmpdir());
  for (let current = path.resolve(workspace); ; current = path.dirname(current)) {
    if (current !== temporary && (await exists(path.join(current, ".git")))) return current;
    const parent = path.dirname(current);
    if (current === temporary || parent === current) return path.resolve(workspace);
  }
}

export async function loadProjectInstructions(workspace: string): Promise<ProjectInstructions | null> {
  const top = await boundary(workspace);
  const directories: string[] = [];
  for (let current = path.resolve(workspace); ; current = path.dirname(current)) {
    directories.unshift(current);
    if (current === top) break;
  }
  const found: Array<{ relative: string; text: string }> = [];
  for (const directory of directories) {
    for (const name of INSTRUCTION_FILES) {
      const text = await fs.readFile(path.join(directory, name), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      if (text.trim()) found.push({ relative: path.relative(top, path.join(directory, name)).split(path.sep).join("/"), text });
      break;
    }
  }
  let remaining = MAX_INSTRUCTION_CHARS;
  const selected: Array<{ relative: string; text: string }> = [];
  for (const item of [...found].reverse()) {
    if (remaining <= 0) break;
    const text = item.text.slice(0, remaining);
    selected.unshift({ relative: item.relative, text });
    remaining -= text.length;
  }
  if (selected.length === 0) return null;
  return {
    sources: selected.map((item) => item.relative),
    text: selected.length === 1 ? selected[0].text.trim() : selected.map((item) => `[${item.relative}]\n${item.text.trim()}`).join("\n\n"),
  };
}

/** The system prompt section, worded as the CLI words it. */
export function instructionsSection(instructions: ProjectInstructions | null): string {
  if (!instructions) return "";
  return `\n\nProject instructions from ${instructions.sources.join(" -> ")}. These come from the project's maintainers, apply from broad to specific, and take precedence over your general habits.\n\n${instructions.text}`;
}
