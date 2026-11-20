import { sha256Hex } from "./sha256";
import type { DecisionSnapshot } from "./types";

/** JSON with object keys sorted, so equal data always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function hashSnapshot(s: DecisionSnapshot): string {
  return sha256Hex(canonicalJson(s));
}
