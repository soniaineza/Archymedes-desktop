import { describe, expect, it } from "vitest";
import { formatCompact, formatCost, formatRelativeTime, matchLocale, translate } from "./core";
import { LOCALES } from "./locales";
import { en } from "./locales/en";
import type { Message } from "./types";

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function variants(message: Message): string[] {
  return typeof message === "string" ? [message] : Object.values(message).filter((v): v is string => v !== undefined);
}

function otherForm(message: Message): string {
  return typeof message === "string" ? message : message.other;
}

describe("locale catalogs", () => {
  const englishKeys = Object.keys(en).sort();

  for (const locale of LOCALES) {
    describe(locale.code, () => {
      it("translates exactly the English keys", () => {
        expect(Object.keys(locale.messages).sort()).toEqual(englishKeys);
      });

      it("keeps every placeholder and never adds new ones", () => {
        for (const key of englishKeys as (keyof typeof en)[]) {
          const source = en[key] as Message;
          const translated = locale.messages[key];
          const allowed = new Set(variants(source).flatMap(placeholders));
          for (const text of variants(translated)) {
            for (const name of placeholders(text)) {
              expect(allowed.has(name), `${locale.code} ${key} uses unknown {${name}}`).toBe(true);
            }
          }
          expect(placeholders(otherForm(translated)), `${locale.code} ${key}`).toEqual(placeholders(otherForm(source)));
        }
      });

      it("has no empty messages", () => {
        for (const [key, message] of Object.entries(locale.messages)) {
          for (const text of variants(message)) expect(text.trim(), `${locale.code} ${key}`).not.toBe("");
        }
      });

      it("uses plural forms exactly where English does", () => {
        for (const key of englishKeys as (keyof typeof en)[]) {
          expect(typeof locale.messages[key], `${locale.code} ${key}`).toBe(typeof en[key]);
        }
      });
    });
  }
});

describe("translate", () => {
  it("interpolates parameters", () => {
    expect(translate("en", "editor.saved", { name: "a.ts" })).toBe("Saved a.ts");
  });

  it("picks plural forms with Intl.PluralRules", () => {
    expect(translate("en", "editor.lines", { count: 1 })).toBe("1 line");
    expect(translate("en", "editor.lines", { count: 1200 })).toBe("1,200 lines");
    expect(translate("ar", "sessions.messages", { count: 2 })).toBe("رسالتان");
  });

  it("formats numbers with the locale's conventions", () => {
    expect(translate("de", "editor.lines", { count: 1200 })).toBe("1.200 Zeilen");
  });

  it("leaves unknown placeholders visible instead of dropping them", () => {
    expect(translate("en", "editor.saved")).toBe("Saved {name}");
  });

  it("falls back to English for an unknown locale", () => {
    expect(translate("xx", "common.save")).toBe("Save");
  });
});

describe("matchLocale", () => {
  it("prefers exact matches, then the same language", () => {
    expect(matchLocale(["pt-BR"])).toBe("pt-BR");
    expect(matchLocale(["pt-PT"])).toBe("pt-BR");
    expect(matchLocale(["fr-CA"])).toBe("fr");
  });

  it("walks the preference list in order", () => {
    expect(matchLocale(["tlh", "de-AT", "fr"])).toBe("de");
  });

  it("defaults to English", () => {
    expect(matchLocale([])).toBe("en");
    expect(matchLocale(["tlh"])).toBe("en");
  });
});

describe("formatters", () => {
  it("keeps two significant digits for sub-cent costs", () => {
    expect(formatCost("en", 1234, "USD")).toBe("$0.0012");
  });

  it("uses the currency's own precision for normal amounts", () => {
    expect(formatCost("en", 1_500_000, "USD")).toBe("$1.50");
    expect(formatCost("en", 2_500_000_000, "JPY")).toBe("¥2,500");
  });

  it("formats compact token counts per locale", () => {
    expect(formatCompact("en", 1234)).toBe("1.2K");
    expect(formatCompact("en", 999)).toBe("999");
  });

  it("describes recent times relatively", () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeTime("en", now - 10_000, now)).toBe("now");
    expect(formatRelativeTime("en", now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelativeTime("en", now - 86_400_000, now)).toBe("yesterday");
  });
});
