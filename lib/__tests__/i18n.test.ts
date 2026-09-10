// @vitest-environment node
import { describe, it, expect } from "vitest";

import en from "@/lib/locales/en.json";
import es from "@/lib/locales/es.json";
import fr from "@/lib/locales/fr.json";
import de from "@/lib/locales/de.json";
import itLocale from "@/lib/locales/it.json";
import ja from "@/lib/locales/ja.json";
import ko from "@/lib/locales/ko.json";
import pt from "@/lib/locales/pt.json";
import ru from "@/lib/locales/ru.json";
import zhHans from "@/lib/locales/zh-Hans.json";

const LOCALES: Record<string, Record<string, string>> = {
  en, es, fr, de, it: itLocale, ja, ko, pt, ru, "zh-Hans": zhHans,
};

const EN_KEYS = Object.keys(en).sort();

/** `{name}`-style interpolation placeholders used by a string. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("locale dictionaries", () => {
  it("has the same key set in every locale", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      expect(Object.keys(dict).sort(), `keys differ in ${locale}`).toEqual(EN_KEYS);
    }
  });

  it("has no empty or whitespace-only values", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(String(value).trim(), `${locale}.${key} is empty`).not.toBe("");
      }
    }
  });

  it("keeps the same interpolation placeholders as English", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      if (locale === "en") continue;
      for (const key of EN_KEYS) {
        expect(placeholders(dict[key]), `${locale}.${key} placeholders differ`).toEqual(
          placeholders(en[key as keyof typeof en])
        );
      }
    }
  });
});
