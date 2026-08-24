"use client";

import { useLocale, LOCALES, type Locale } from "@/lib/i18n";

/** Dropdown to switch the interface language between the supported locales. */
export function LanguageSelector({
  style,
  className,
  fullWidth = false,
}: {
  style?: React.CSSProperties;
  className?: string;
  fullWidth?: boolean;
}) {
  const { locale, setLocale } = useLocale();

  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label="Language"
      className={["input", className ?? ""].filter(Boolean).join(" ").trim()}
      style={{
        width: fullWidth ? "100%" : "auto",
        ...style,
      }}
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>{l.name}</option>
      ))}
    </select>
  );
}