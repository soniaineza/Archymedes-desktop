import { createContext, useContext, useEffect, useState } from "react";
import type { EntMethod, Member, SessionInfo } from "@shared/enterprise/api-types";
import { formatMoney, formatPct } from "@shared/enterprise/money";

export class EntCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EntCtx {
  workspaceId: string;
  me: SessionInfo["identities"][number];
  currency: string;
  /** Bumps after every successful mutation so views refetch. */
  version: number;
  call<T>(method: EntMethod, path: string, body?: unknown, opts?: { ifRevision?: number; idempotent?: boolean }): Promise<T>;
  signOut(): void;
  setCurrency(c: string): void;
}

export const EntContext = createContext<EntCtx | null>(null);

export function useEnt(): EntCtx {
  const c = useContext(EntContext);
  if (!c) throw new Error("useEnt outside EntProvider");
  return c;
}

export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** GET a resource; refetches whenever a mutation lands or `path` changes. */
export function useGet<T>(path: string | null): { data: T | null; error: EntCallError | null; loading: boolean; reload(): void } {
  const { call, version } = useEnt();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<EntCallError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    call<T>("GET", path)
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => live && setError(e instanceof EntCallError ? e : new EntCallError(0, "error", String(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [call, path, version, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

// ---- formatting ----

export const money = (minor: number | null | undefined, currency: string, opts?: { compact?: boolean; signed?: boolean }) =>
  minor === null || minor === undefined ? "—" : formatMoney(minor, currency, opts);
export const pct = formatPct;
export const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const dateShort = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
export const ago = (iso: string, now = Date.now()) => {
  const h = (now - Date.parse(iso)) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

export function metricValue(v: number | null | undefined, unit: "money" | "count" | "ratio", currency: string, compact = false): string {
  if (v === null || v === undefined) return "—";
  if (unit === "money") return formatMoney(Math.round(v), currency, { compact });
  if (unit === "ratio") return formatPct(v, 1);
  return v.toLocaleString("en-US");
}

export function roleLabel(role: Member["role"]): string {
  return { admin: "Admin", executive: "Executive", lead: "Revenue lead", operator: "Operator", finance: "Finance reviewer", auditor: "Auditor" }[role];
}

export const STATE_LABEL: Record<string, string> = {
  Draft: "Draft",
  Evaluated: "Evaluated",
  NeedsEvidence: "Needs evidence",
  AwaitingApproval: "Awaiting approval",
  Approved: "Approved",
  Rejected: "Rejected",
  Executing: "Executing",
  DeliveryReview: "Delivery review",
  Measuring: "Measuring",
  Debriefed: "Debriefed",
  Cancelled: "Cancelled",
};

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stateTone(s: string): "neutral" | "good" | "warn" | "bad" | "accent" {
  if (["AwaitingApproval", "DeliveryReview", "NeedsEvidence"].includes(s)) return "warn";
  if (["Rejected", "Cancelled"].includes(s)) return "bad";
  if (["Debriefed", "Approved"].includes(s)) return "good";
  if (["Executing", "Measuring"].includes(s)) return "accent";
  return "neutral";
}
