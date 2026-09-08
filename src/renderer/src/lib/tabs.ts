export interface OpenTab {
  path: string;
  content: string;
  original: string;
  truncated?: boolean;
}

export function isDirty(tab: OpenTab): boolean {
  return tab.content !== tab.original;
}

export function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}
