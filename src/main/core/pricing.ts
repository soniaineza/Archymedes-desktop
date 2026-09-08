/**
 * Port of the CLI's pricing module (packages/core/src/pricing.ts): scoped,
 * dated price records with alias reduction for dated snapshots.
 */

import { tokenPrices, type TokenPrices } from "./money";

export type PriceModality = "text" | "embedding" | "image" | "audio" | "search" | "compute";
export type BillingUnit = "tokens" | "requests" | "pages" | "images" | "seconds" | "characters";

export type PriceRecord = {
  provider: string;
  model: string;
  modality: PriceModality;
  currency: string;
  billingUnit: BillingUnit;
  per: number;
  rates: Readonly<Record<string, number>>;
  largeContext?: TokenPrices["largeContext"];
  source: string;
  effectiveFrom: string;
  effectiveUntil?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO date (YYYY-MM-DD), got "${value}"`);
}

export function validatePriceRecord(record: PriceRecord): PriceRecord {
  if (!record.provider.trim()) throw new Error("Price record needs a provider");
  if (!record.model.trim()) throw new Error("Price record needs a model or meter name");
  if (!record.source.trim()) throw new Error(`Price for ${record.provider}/${record.model} needs a source`);
  if (!Number.isFinite(record.per) || record.per <= 0) throw new Error(`Price for ${record.provider}/${record.model} needs a positive "per"`);
  assertDate(record.effectiveFrom, `effectiveFrom for ${record.provider}/${record.model}`);
  if (record.effectiveUntil !== undefined) {
    assertDate(record.effectiveUntil, `effectiveUntil for ${record.provider}/${record.model}`);
    if (record.effectiveUntil <= record.effectiveFrom) throw new Error(`Price for ${record.provider}/${record.model} ends before it starts`);
  }
  if (Object.keys(record.rates).length === 0) throw new Error(`Price for ${record.provider}/${record.model} has no rates`);
  return record;
}

export type PriceQuery = { provider: string; model: string; asOf?: string };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function covers(record: PriceRecord, date: string): boolean {
  return record.effectiveFrom <= date && (record.effectiveUntil === undefined || date < record.effectiveUntil);
}

/**
 * The ids a model can be priced under: `-YYYYMMDD` snapshots and `-latest`
 * pointers reduce to their family so a pinned run prices like the unpinned one.
 */
export function priceAliases(model: string): string[] {
  const aliases = [model];
  let candidate = model;
  for (let step = 0; step < 3; step += 1) {
    const trimmed = candidate.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/i, "");
    if (trimmed === candidate || !trimmed) break;
    candidate = trimmed;
    aliases.push(candidate);
  }
  return aliases;
}

/** The rate in force for one model on one date; later effectiveFrom wins. */
export function selectPrice(records: readonly PriceRecord[], query: PriceQuery): PriceRecord | undefined {
  const date = query.asOf ?? today();
  for (const model of priceAliases(query.model)) {
    const match = records
      .filter((r) => r.provider === query.provider && r.model === model && covers(r, date))
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
    if (match) return match;
  }
  return undefined;
}

export function tokenPricesFor(record: PriceRecord): TokenPrices {
  if (record.billingUnit !== "tokens") throw new Error(`${record.provider}/${record.model} is billed per ${record.billingUnit}, not tokens`);
  const { input, output, cachedInput } = record.rates;
  if (input === undefined || output === undefined) throw new Error(`${record.provider}/${record.model} needs input and output rates`);
  const scale = 1_000_000 / record.per;
  return tokenPrices(record.currency, input * scale, output * scale, cachedInput === undefined ? undefined : cachedInput * scale, record.largeContext);
}

export function tokenPricesAt(records: readonly PriceRecord[], query: PriceQuery): TokenPrices | undefined {
  const record = selectPrice(records, query);
  return record && record.billingUnit === "tokens" ? tokenPricesFor(record) : undefined;
}

export function definePrices(records: readonly PriceRecord[]): readonly PriceRecord[] {
  return records.map(validatePriceRecord);
}
