import { useSyncExternalStore } from "react";

/**
 * Client-side UI preferences (editor, chat, general behaviour). They only affect
 * this window's rendering, so they live in localStorage rather than the main
 * process settings file, apply instantly, and survive restarts.
 */

export type AutoSaveMode = "off" | "afterDelay" | "onFocusChange";
export type SendKey = "enter" | "ctrlEnter";

export interface Prefs {
  /** Editor */
  autoSave: AutoSaveMode;
  autoSaveDelay: number;
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  bracketColors: boolean;
  /** Chat */
  chatSendKey: SendKey;
  codeLineNumbers: boolean;
  codeWordWrap: boolean;
  showTokenUsage: boolean;
  /** General */
  restoreLastChat: boolean;
  confirmCloseDirty: boolean;
  reduceMotion: boolean;
  /** One-time notices: the free-mode privacy banner was dismissed. Not a setting, so no panel resets it. */
  freePrivacyNoticeDismissed: boolean;
}

export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({
  autoSave: "off",
  autoSaveDelay: 1000,
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: false,
  editorLineNumbers: true,
  bracketColors: true,
  chatSendKey: "enter",
  codeLineNumbers: false,
  codeWordWrap: false,
  showTokenUsage: true,
  restoreLastChat: true,
  confirmCloseDirty: true,
  reduceMotion: false,
  freePrivacyNoticeDismissed: false,
});

export const EDITOR_PREF_KEYS = [
  "autoSave",
  "autoSaveDelay",
  "editorFontSize",
  "editorTabSize",
  "editorWordWrap",
  "editorLineNumbers",
  "bracketColors",
] as const satisfies readonly (keyof Prefs)[];
export const CHAT_PREF_KEYS = ["chatSendKey", "codeLineNumbers", "codeWordWrap", "showTokenUsage"] as const satisfies readonly (keyof Prefs)[];
export const GENERAL_PREF_KEYS = ["restoreLastChat", "confirmCloseDirty", "reduceMotion"] as const satisfies readonly (keyof Prefs)[];

export const FONT_SIZE_RANGE = { min: 10, max: 24 } as const;
export const TAB_SIZES = [2, 4, 8] as const;
export const AUTO_SAVE_DELAY_RANGE = { min: 200, max: 60_000 } as const;

const STORAGE_KEY = "archymedes.prefs";

const clampInt = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined;
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find((a) => a === value);

/** Validate untrusted stored JSON field by field; anything unknown or invalid falls back to the default. */
export function parsePrefs(raw: unknown): Prefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PREFS;
  return {
    autoSave: oneOf(o.autoSave, ["off", "afterDelay", "onFocusChange"] as const) ?? d.autoSave,
    autoSaveDelay: clampInt(o.autoSaveDelay, AUTO_SAVE_DELAY_RANGE.min, AUTO_SAVE_DELAY_RANGE.max) ?? d.autoSaveDelay,
    editorFontSize: clampInt(o.editorFontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max) ?? d.editorFontSize,
    editorTabSize: oneOf(String(o.editorTabSize), ["2", "4", "8"] as const) ? Number(o.editorTabSize) : d.editorTabSize,
    editorWordWrap: bool(o.editorWordWrap) ?? d.editorWordWrap,
    editorLineNumbers: bool(o.editorLineNumbers) ?? d.editorLineNumbers,
    bracketColors: bool(o.bracketColors) ?? d.bracketColors,
    chatSendKey: oneOf(o.chatSendKey, ["enter", "ctrlEnter"] as const) ?? d.chatSendKey,
    codeLineNumbers: bool(o.codeLineNumbers) ?? d.codeLineNumbers,
    codeWordWrap: bool(o.codeWordWrap) ?? d.codeWordWrap,
    showTokenUsage: bool(o.showTokenUsage) ?? d.showTokenUsage,
    restoreLastChat: bool(o.restoreLastChat) ?? d.restoreLastChat,
    confirmCloseDirty: bool(o.confirmCloseDirty) ?? d.confirmCloseDirty,
    reduceMotion: bool(o.reduceMotion) ?? d.reduceMotion,
    freePrivacyNoticeDismissed: bool(o.freePrivacyNoticeDismissed) ?? d.freePrivacyNoticeDismissed,
  };
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return parsePrefs(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let current: Prefs | null = null;
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  current ??= load();
  return current;
}

function commit(next: Prefs): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // preferences are best-effort
  }
  for (const listener of listeners) listener();
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  commit(parsePrefs({ ...getPrefs(), [key]: value }));
}

/** Restore the given keys (or all of them) to their defaults. */
export function resetPrefs(keys: readonly (keyof Prefs)[] = Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]): void {
  const next: Prefs = { ...getPrefs() };
  for (const key of keys) (next as unknown as Record<string, unknown>)[key] = DEFAULT_PREFS[key];
  commit(next);
}

/** Forget the cached copy (tests clear localStorage between cases). */
export function reloadPrefs(): void {
  current = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) reloadPrefs();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** All preferences; re-renders when any of them changes. */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

/** One preference, e.g. `usePref("showTokenUsage")`; re-renders only when it changes. */
export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  return useSyncExternalStore(
    subscribe,
    () => getPrefs()[key],
    () => getPrefs()[key],
  );
}

/**
 * Reflect the CSS-driven preferences on <html> so plain stylesheets can follow them
 * (code-block line numbers and wrapping, bracket colours, reduced motion, editor metrics).
 */
export function applyPrefsToDocument(prefs: Prefs, root: HTMLElement = document.documentElement): void {
  root.dataset.codeLineNumbers = prefs.codeLineNumbers ? "on" : "off";
  root.dataset.codeWrap = prefs.codeWordWrap ? "on" : "off";
  root.dataset.bracketColors = prefs.bracketColors ? "on" : "off";
  root.dataset.reduceMotion = prefs.reduceMotion ? "on" : "off";
  root.style.setProperty("--editor-font-size", `${prefs.editorFontSize}px`);
  root.style.setProperty("--editor-line-height", `${Math.round(prefs.editorFontSize * 1.6)}px`);
  root.style.setProperty("--editor-tab-size", String(prefs.editorTabSize));
}
