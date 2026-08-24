"use client";

import { createContext, useContext, useEffect, useState } from "react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import en from "@/lib/locales/en.json";
import es from "@/lib/locales/es.json";
import fr from "@/lib/locales/fr.json";
import de from "@/lib/locales/de.json";
import it from "@/lib/locales/it.json";
import ja from "@/lib/locales/ja.json";
import ko from "@/lib/locales/ko.json";
import pt from "@/lib/locales/pt.json";
import ru from "@/lib/locales/ru.json";
import zhHans from "@/lib/locales/zh-Hans.json";

export type Locale = "en" | "es" | "fr" | "de" | "it" | "ja" | "ko" | "pt" | "ru" | "zh-Hans";

export const LOCALES: { code: Locale; name: string }[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "pt", name: "Português" },
  { code: "ru", name: "Русский" },
  { code: "zh-Hans", name: "简体中文" },
];

export type Translations = typeof en;

const resources = {
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  de: { translation: de },
  it: { translation: it },
  ja: { translation: ja },
  ko: { translation: ko },
  pt: { translation: pt },
  ru: { translation: ru },
  "zh-Hans": { translation: zhHans },
} as const;

i18next.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

const LocaleContext = createContext<{
  t: Translations;
  locale: Locale;
  setLocale: (l: Locale) => void;
}>({
  t: {} as Translations,
  locale: "en",
  setLocale: () => {},
});

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  // Load the saved locale (or the browser language) once, then switch i18next.
  useEffect(() => {
    const saved = localStorage.getItem("locale") as Locale | null;
    const resolved: Locale =
      saved && LOCALES.some((l) => l.code === saved)
        ? saved
        : (() => {
            const nav = (navigator.language || "en").toLowerCase();
            if (nav.startsWith("es")) return "es";
            if (nav.startsWith("fr")) return "fr";
            if (nav.startsWith("de")) return "de";
            if (nav.startsWith("it")) return "it";
            if (nav.startsWith("ja")) return "ja";
            if (nav.startsWith("ko")) return "ko";
            if (nav.startsWith("pt")) return "pt";
            if (nav.startsWith("ru")) return "ru";
            if (nav.startsWith("zh")) return "zh-Hans";
            return "en";
          })();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocaleState(resolved);
    void i18next.changeLanguage(resolved);
  }, []);

  function setLocale(l: Locale) {
    setLocaleState(l);
    localStorage.setItem("locale", l);
    void i18next.changeLanguage(l);
  }

  // Proxy keeps the existing `t.key` object-style API while i18next does the
  // lookup, so components don't need to change.
  const t = new Proxy({} as Translations, {
    get: (_t, prop) => {
      if (typeof prop !== "string") return undefined;
      const key = prop as keyof Translations;
      const value = i18next.t(key);
      return typeof value === "string" && value !== key ? value : (en as Translations)[key];
    },
  });

  return (
    <LocaleContext.Provider value={{ t, locale, setLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}