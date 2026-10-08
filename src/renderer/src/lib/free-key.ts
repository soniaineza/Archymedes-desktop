/** Where a free-mode key stands: not tested since it changed, being tested, or the last test's answer. */
export type KeyVerdict = "untested" | "testing" | "works" | "failed" | "save-anyway";

/** Whether a free-mode key in this state may be saved: unchanged, tested, or explicitly accepted. */
export function freeKeySavable(verdict: KeyVerdict, keyChanged: boolean, apiKey: string): boolean {
  if (!keyChanged || !apiKey.trim()) return true;
  return verdict === "works" || verdict === "save-anyway";
}
