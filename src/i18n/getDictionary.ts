import type { Locale } from "./config";
import ja from "./dictionaries/ja";
import en from "./dictionaries/en";

const dictionaries = { ja, en };

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}

export type Dictionary = typeof ja;
