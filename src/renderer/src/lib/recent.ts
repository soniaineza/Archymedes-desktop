const RECENT_KEY = "archymedes.recent-workspaces";
const MAX_RECENT = 6;

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // storage unavailable; recents are a nicety, not a requirement
  }
}

export function pushRecent(path: string): void {
  writeRecent([path, ...readRecent().filter((p) => p !== path)]);
}

export function removeRecent(path: string): string[] {
  const list = readRecent().filter((p) => p !== path);
  writeRecent(list);
  return list;
}
