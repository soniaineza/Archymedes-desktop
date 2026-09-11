import type { LocaleInfo } from "../types";
import { ar } from "./ar";
import { de } from "./de";
import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { hi } from "./hi";
import { ja } from "./ja";
import { ptBR } from "./pt-BR";
import { rw } from "./rw";
import { sw } from "./sw";
import { zhCN } from "./zh-CN";

export const LOCALES: readonly LocaleInfo[] = [
  { code: "en", name: "English", englishName: "English", dir: "ltr", messages: en },
  { code: "es", name: "Español", englishName: "Spanish", dir: "ltr", messages: es },
  { code: "fr", name: "Français", englishName: "French", dir: "ltr", messages: fr },
  { code: "de", name: "Deutsch", englishName: "German", dir: "ltr", messages: de },
  { code: "pt-BR", name: "Português (Brasil)", englishName: "Brazilian Portuguese", dir: "ltr", messages: ptBR },
  { code: "zh-CN", name: "简体中文", englishName: "Simplified Chinese", dir: "ltr", messages: zhCN },
  { code: "ja", name: "日本語", englishName: "Japanese", dir: "ltr", messages: ja },
  { code: "ar", name: "العربية", englishName: "Arabic", dir: "rtl", messages: ar },
  { code: "hi", name: "हिन्दी", englishName: "Hindi", dir: "ltr", messages: hi },
  { code: "sw", name: "Kiswahili", englishName: "Swahili", dir: "ltr", messages: sw },
  { code: "rw", name: "Ikinyarwanda", englishName: "Kinyarwanda", dir: "ltr", messages: rw },
];
