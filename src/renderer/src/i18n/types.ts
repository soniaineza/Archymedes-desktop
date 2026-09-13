import type { en } from "./locales/en";

export type PluralCategory = "zero" | "one" | "two" | "few" | "many";

/** A message whose wording depends on `params.count`, chosen with Intl.PluralRules. */
export type PluralMessage = { other: string } & Partial<Record<PluralCategory, string>>;

export type Message = string | PluralMessage;

export type MessageKey = keyof typeof en;

/** Every locale must translate every key; the compiler enforces completeness. */
export type Messages = Record<MessageKey, Message>;

export type Params = Record<string, string | number>;

export interface LocaleInfo {
  /** BCP 47 tag, e.g. "pt-BR". */
  code: string;
  /** The language's name in itself, e.g. "Français". */
  name: string;
  /** English name, used to instruct the model ("Reply in French"). */
  englishName: string;
  dir: "ltr" | "rtl";
  messages: Messages;
}
