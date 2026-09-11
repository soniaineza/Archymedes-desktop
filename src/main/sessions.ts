import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../shared/types";

/**
 * Chat session persistence. Sessions are the CLI's "resume where you left
 * off" story: every conversation is stored as JSON under the app's userData
 * dir, listed by recency, and reloadable into the chat panel.
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
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function listSessions(userDataPath: string) {
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

export async function loadSession(userDataPath: string, id: string): Promise<StoredSession | null> {
  if (!/^[\w-]+$/.test(id)) return null; // id safety: no traversal
  try {
    const raw = await fs.readFile(path.join(sessionsDir(userDataPath), `${id}.json`), "utf8");
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function saveSession(userDataPath: string, session: StoredSession): Promise<void> {
  if (!/^[\w-]+$/.test(session.id)) throw new Error(`Invalid session id: ${session.id}`);
  const dir = sessionsDir(userDataPath);
  await ensureDir(dir);
  const file = path.join(dir, `${session.id}.json`);
  await fs.writeFile(file, JSON.stringify(session, null, 2), "utf8");
}

export async function deleteSession(userDataPath: string, id: string): Promise<void> {
  if (!/^[\w-]+$/.test(id)) return;
  await fs.rm(path.join(sessionsDir(userDataPath), `${id}.json`), { force: true });
}

export async function renameSession(userDataPath: string, id: string, title: string): Promise<void> {
  const session = await loadSession(userDataPath, id);
  if (!session) return;
  session.title = title.slice(0, 80);
  session.updatedAt = Date.now();
  await saveSession(userDataPath, session);
}
