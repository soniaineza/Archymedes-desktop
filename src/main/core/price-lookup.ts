import { tokenPrices, type TokenPrices } from "./money";
import { selectPrice } from "./pricing";
import { PRICE_CATALOG } from "./price-catalog";
import type { ProviderId } from "./providers";

/** Catalog price for a provider/model, or undefined when unpriced. */
export function catalogPricesOf(provider: ProviderId, model: string, asOf?: string): TokenPrices | undefined {
  if (provider === "ollama" || provider === "free") return tokenPrices("USD", 0, 0, 0);
  const record = selectPrice(PRICE_CATALOG, { provider, model, asOf });
  return record && record.billingUnit === "tokens" ? tokenPricesFor(record) : undefined;
}

function tokenPricesFor(record: NonNullable<ReturnType<typeof selectPrice>>): TokenPrices {
  const { input, output, cachedInput } = record.rates;
  if (input === undefined || output === undefined) return undefined as never;
  const scale = 1_000_000 / record.per;
  return tokenPrices(record.currency, input * scale, output * scale, cachedInput === undefined ? undefined : cachedInput * scale, record.largeContext);
}
