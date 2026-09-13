import type { FileNode } from "@shared/types";

export type FileKind = "code" | "style" | "doc" | "data" | "config" | "image" | "other";

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code", py: "code", rs: "code",
  go: "code", java: "code", kt: "code", c: "code", h: "code", cpp: "code", cs: "code", rb: "code",
  php: "code", swift: "code", sh: "code", ps1: "code", sql: "code", dart: "code", lua: "code",
  css: "style", scss: "style", less: "style", html: "style", vue: "style", svelte: "style",
  md: "doc", mdx: "doc", txt: "doc", rst: "doc", pdf: "doc",
  json: "data", yaml: "data", yml: "data", toml: "data", csv: "data", xml: "data", ini: "data",
  lock: "config", env: "config", gitignore: "config", editorconfig: "config", dockerfile: "config",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image", ico: "image",
};

export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  return KIND_BY_EXTENSION[ext] ?? "other";
}

export function flattenFiles(nodes: FileNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === "file") out.push(node.path);
    if (node.children) flattenFiles(node.children, out);
  }
  return out;
}
