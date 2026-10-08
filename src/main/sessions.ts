import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../shared/types";

/**
 * Chat session persistence. Sessions are the CLI's "resume where you left
 * off" story: every conversation is stored as JSON under the app's userData
 * dir, listed by recency, and reloadable into the chat panel.
 *
 * Every chat belongs to the project folder it was started in. The main process stamps that folder
 * on save (the renderer cannot choose it) and only lists, opens, renames or deletes chats of the
 * folder that is open now, so one project's conversations never surface in another. Chats saved
 * before this existed carry no folder; they appear only while no folder is open.
 */

const SESSIONS_DIR = "sessions";

export function sessionsDir(userDataPath: string): string {
  return path.join(userDataPath, SESSIONS_DIR);
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** The project folder the chat belongs to; absent on chats saved by older builds. */
  workspace?: string;
}

/** The open folder as a comparable key: resolved, and case-folded where the file system ignores case. */
function workspaceKey(root: string | null | undefined): string | null {
  if (!root) return null;
  const resolved = path.resolve(root).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/** Whether a stored chat belongs to the folder open now (`null`: no folder open). */
export function belongsTo(session: Pick<StoredSession, "workspace">, workspace: string | null): boolean {
  return workspaceKey(session.workspace) === workspaceKey(workspace);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function listSessions(userDataPath: string, workspace: string | null) {
  const dir = sessionsDir(userDataPath);
  await ensureDir(dir);
  const files = await fs.readdir(dir);
  const summaries: Array<{
    id: string;
    title: string;
    updatedAt: number;
    messageCount: number;
  }> = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      const session = JSON.parse(raw) as StoredSession;
      if (!belongsTo(session, workspace)) continue;
      summaries.push({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
      });
    } catch {
      // corrupt session file: skip rather than break the whole list
    }
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/** A stored chat by id, whichever folder it belongs to. Callers outside this file go through the folder check. */
async function readSession(userDataPath: string, id: string): Promise<StoredSession | null> {
  if (!/^[\w-]+$/.test(id)) return null; // id safety: no traversal
  try {
    const raw = await fs.readFile(path.join(sessionsDir(userDataPath), `${id}.json`), "utf8");
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function loadSession(userDataPath: string, id: string, workspace: string | null): Promise<StoredSession | null> {
  const session = await readSession(userDataPath, id);
  return session && belongsTo(session, workspace) ? session : null;
}

export async function saveSession(userDataPath: string, session: StoredSession, workspace: string | null): Promise<void> {
  if (!/^[\w-]+$/.test(session.id)) throw new Error(`Invalid session id: ${session.id}`);
  // A chat keeps the folder it was first saved in: an id that already belongs to another project is
  // never rewritten into this one, whatever the renderer sends.
  const existing = await readSession(userDataPath, session.id);
  if (existing && !belongsTo(existing, workspace)) throw new Error("This chat belongs to a different project.");
  const dir = sessionsDir(userDataPath);
  await ensureDir(dir);
  const file = path.join(dir, `${session.id}.json`);
  const stored: StoredSession = { ...session, workspace: workspace ? path.resolve(workspace) : undefined };
  await fs.writeFile(file, JSON.stringify(stored, null, 2), "utf8");
}

export async function deleteSession(userDataPath: string, id: string, workspace: string | null): Promise<void> {
  const session = await readSession(userDataPath, id);
  if (!session || !belongsTo(session, workspace)) return;
  await fs.rm(path.join(sessionsDir(userDataPath), `${id}.json`), { force: true });
}

/** Deletes every chat of the open folder, and only those; returns how many were removed. */
export async function deleteAllSessions(userDataPath: string, workspace: string | null): Promise<number> {
  const sessions = await listSessions(userDataPath, workspace);
  await Promise.all(sessions.map((s) => fs.rm(path.join(sessionsDir(userDataPath), `${s.id}.json`), { force: true })));
  return sessions.length;
}

export async function renameSession(userDataPath: string, id: string, title: string, workspace: string | null): Promise<void> {
  const session = await loadSession(userDataPath, id, workspace);
  if (!session) return;
  session.title = title.slice(0, 80);
  session.updatedAt = Date.now();
  await saveSession(userDataPath, session, workspace);
}

/** A chat saved before chats were linked to a project folder. */
function isLegacy(session: Pick<StoredSession, "workspace">): boolean {
  return !session.workspace;
}

async function readAll(userDataPath: string): Promise<StoredSession[]> {
  const dir = sessionsDir(userDataPath);
  await ensureDir(dir);
  const sessions: StoredSession[] = [];
  for (const file of await fs.readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const session = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as StoredSession;
      if (session && typeof session.id === "string" && `${session.id}.json` === file) sessions.push(session);
    } catch {
      // corrupt session file: skip
    }
  }
  return sessions;
}

/**
 * Chats with no project folder, newest first. Only reported while a folder is open: with none open
 * they are already in the normal list.
 */
export async function listLegacySessions(userDataPath: string, workspace: string | null): Promise<{ count: number; ids: string[] }> {
  if (!workspace) return { count: 0, ids: [] };
  const legacy = (await readAll(userDataPath)).filter(isLegacy).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { count: legacy.length, ids: legacy.map((s) => s.id) };
}

/**
 * Links chats that have no project folder to the folder open now. Only chats without a folder are
 * touched; a chat that belongs to any project, this one or another, is never re-assigned. Returns
 * how many chats were linked.
 */
export async function adoptLegacySessions(userDataPath: string, ids: readonly string[] | "all", workspace: string | null): Promise<number> {
  if (!workspace) return 0;
  const wanted = ids === "all" ? null : new Set(ids.filter((id) => /^[\w-]+$/.test(id)));
  let adopted = 0;
  for (const session of await readAll(userDataPath)) {
    if (!isLegacy(session) || (wanted && !wanted.has(session.id))) continue;
    // Re-read right before writing, so a chat saved into a project meanwhile is left alone.
    const fresh = await readSession(userDataPath, session.id);
    if (!fresh || !isLegacy(fresh)) continue;
    const stored: StoredSession = { ...fresh, workspace: path.resolve(workspace) };
    const file = path.join(sessionsDir(userDataPath), `${session.id}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(stored, null, 2), "utf8");
    await fs.rename(temp, file);
    adopted += 1;
  }
  return adopted;
}
