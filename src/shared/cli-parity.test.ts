/**
 * Every model the CLI offers must also be offered here. The CLI is the reference for which
 * providers exist and which models the price catalog knows; the desktop keeps hand-ported copies.
 * This test reads the CLI's sources as text (no import across repos) and fails when they drift.
 *
 * Skipped when the CLI checkout is not next to this app (e.g. a standalone desktop clone).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRICE_CATALOG, UNPRICED_PROVIDERS } from "../main/core/price-catalog";
import { modelsForProvider } from "../main/models";
import { PROVIDER_IDS, PROVIDER_INFO } from "./providers";

// src/shared → src → "Archymedes desktop" → the folder holding both checkouts.
const CLI_CORE = path.resolve(__dirname, "../../../archymedes-cli-master/packages/core/src");
const SPECS = path.join(CLI_CORE, "providers/provider-specs.ts");
const PRICES = path.join(CLI_CORE, "providers/price-catalog.ts");
const FREE = path.join(CLI_CORE, "providers/free-catalog.ts");
const present = existsSync(SPECS) && existsSync(PRICES) && existsSync(FREE);

const read = (file: string) => readFileSync(file, "utf8");

/** `export const NAME = "value"` constants, for resolving `defaultModel: FREE_ROUTER`. */
function stringConstants(...sources: string[]): Map<string, string> {
  const constants = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.matchAll(/(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*\w+\s*)?=\s*"([^"]*)"/g)) constants.set(match[1], match[2]);
  }
  return constants;
}

/** The block of text from `marker` to the matching closing bracket. */
function block(source: string, marker: string, open: "{" | "["): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${marker} not found in CLI source`);
  const close = open === "{" ? "}" : "]";
  // From the `=`, so a type annotation like `readonly string[]` is not taken for the value.
  let index = source.indexOf(open, source.indexOf("=", start + marker.length));
  let depth = 0;
  for (const begin = index; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close && --depth === 0) return source.slice(begin, index + 1);
  }
  throw new Error(`${marker} block is not closed`);
}

type CliProvider = { id: string; label: string; defaultModel: string };

function cliProviders(): { ids: string[]; info: CliProvider[] } {
  const specs = read(SPECS);
  const constants = stringConstants(specs, read(FREE));
  const ids = [...block(specs, "export const PROVIDER_IDS", "[").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const info: CliProvider[] = [];
  const body = block(specs, "export const PROVIDER_INFO", "{");
  const starts = [...body.matchAll(/\bid:\s*"([^"]+)"/g)];
  starts.forEach((start, n) => {
    const chunk = body.slice(start.index, starts[n + 1]?.index ?? body.length);
    const label = /\blabel:\s*"([^"]+)"/.exec(chunk)?.[1];
    const model = /\bdefaultModel:\s*(?:"([^"]+)"|([A-Z_][A-Z0-9_]*))/.exec(chunk);
    const defaultModel = model?.[1] ?? (model?.[2] ? constants.get(model[2]) : undefined);
    if (!label || !defaultModel) throw new Error(`Could not read label/defaultModel for CLI provider ${start[1]}`);
    info.push({ id: start[1], label, defaultModel });
  });
  return { ids, info };
}

/** `provider|model|currency|input|output|cached` for every text/token price the CLI records. */
function cliTokenPrices(): string[] {
  const source = read(PRICES);
  const tuples: string[] = [];
  const num = (value: string) => (value === "undefined" ? "-" : String(Number(value)));
  // `...["a", "b"].map((model) => tokens("anthropic", model, "USD", 5, 25, 0.5, …))`
  for (const m of source.matchAll(/\[([^\]]*)\]\.map\(\(model\)\s*=>\s*tokens\(\s*"([^"]+)",\s*model,\s*"([A-Z]{3})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+|undefined)/g)) {
    for (const model of [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])) tuples.push([m[2], model, m[3], num(m[4]), num(m[5]), num(m[6])].join("|"));
  }
  // `tokens("google", "gemini-2.5-pro", "USD", 1.25, 10, 0.31, …)`
  for (const m of source.matchAll(/tokens\(\s*"([^"]+)",\s*"([^"]+)",\s*"([A-Z]{3})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+|undefined)/g)) {
    tuples.push([m[1], m[2], m[3], num(m[4]), num(m[5]), num(m[6])].join("|"));
  }
  return tuples.sort();
}

function desktopTokenPrices(): string[] {
  return PRICE_CATALOG.filter((r) => r.modality === "text" && r.billingUnit === "tokens")
    .map((r) => [r.provider, r.model, r.currency, String(r.rates.input), String(r.rates.output), r.rates.cachedInput === undefined ? "-" : String(r.rates.cachedInput)].join("|"))
    .sort();
}

describe.skipIf(!present)("parity with the CLI at ../archymedes-cli-master", () => {
  it("offers every CLI provider, in the CLI's order", () => {
    const { ids } = cliProviders();
    expect(ids.length).toBeGreaterThan(0);
    expect([...PROVIDER_IDS]).toEqual(ids);
  });

  it("gives every provider the CLI's label and default model", () => {
    const { info } = cliProviders();
    expect(info.length).toBe(PROVIDER_IDS.length);
    for (const provider of info) {
      const desktop = PROVIDER_INFO[provider.id as keyof typeof PROVIDER_INFO];
      expect(desktop, provider.id).toBeDefined();
      expect({ id: provider.id, label: desktop.label, defaultModel: desktop.defaultModel }).toEqual(provider);
    }
  });

  it("prices every CLI text model at the CLI's rates", () => {
    const cli = cliTokenPrices();
    expect(cli.length).toBeGreaterThan(5);
    expect(desktopTokenPrices()).toEqual(cli);
  });

  it("lists the same known models per provider as the CLI's modelsForProvider", () => {
    // modelsForProvider = default + the provider's text/token catalog models; with the catalogs equal
    // (above), the lists are equal exactly when every catalog model appears in the desktop list.
    for (const tuple of cliTokenPrices()) {
      const [provider, model] = tuple.split("|");
      expect(modelsForProvider(provider as (typeof PROVIDER_IDS)[number]), provider).toContain(model);
    }
  });

  it("leaves the same providers unpriced", () => {
    const list = block(read(PRICES), "export const UNPRICED_PROVIDERS", "[");
    expect([...UNPRICED_PROVIDERS].sort()).toEqual([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort());
  });
});
