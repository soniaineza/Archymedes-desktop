import { walkWorkspace } from "./workspace";

export {
  WorkspaceViolation,
  realPathWithin,
  displayPath,
  readTextFile,
  writeTextFile,
  editTextFile,
  globWorkspace,
  grepWorkspace,
  DEFAULT_WORKSPACE_LIMITS,
} from "./workspace";

/** Recursive listing for the list_dir tool, in the CLI's walk order. */
export async function listFilesFallback(workspace: string, prefix: string): Promise<string> {
  const base = prefix && prefix !== "." ? prefix.replace(/^\.\//, "").replace(/\/$/, "") : "";
  const entries: string[] = [];
  for await (const entry of walkWorkspace(workspace)) {
    if (base && !entry.relative.startsWith(base + "/") && entry.relative !== base) continue;
    entries.push(entry.isDirectory ? `${entry.relative}/` : entry.relative);
  }
  return entries.length > 0 ? entries.join("\n") : "No entries.";
}
