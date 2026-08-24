"use client";

import { useState, useEffect, useRef } from "react";
import { useLocale, LOCALES, type Locale } from "@/lib/i18n";

const FLAGS: Record<string, string> = {
  en: "🇬🇧",
  es: "🇪🇸",
  fr: "🇫🇷",
  de: "🇩🇪",
  it: "🇮🇹",
  ja: "🇯🇵",
  ko: "🇰🇷",
  pt: "🇵🇹",
  ru: "🇷🇺",
  "zh-Hans": "🇨🇳",
};

/**
 * Language selector styled like the visibility picker: a button showing the
 * current language's flag + name with a dropdown listing every supported
 * locale (flag + native name).
 */
export function LanguagePicker({
  direction = "down",
  fullWidth = false,
}: {
  direction?: "up" | "down";
  fullWidth?: boolean;
}) {
  const { locale, setLocale } = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];

  const menuStyle: React.CSSProperties = {
    position: "absolute",
    [direction === "down" ? "top" : "bottom"]: "calc(100% + 6px)",
    left: 0,
    zIndex: 200,
    minWidth: 180,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "0.25rem",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 4px 24px rgba(0,0,0,0.22)",
    ...(fullWidth ? { width: "100%" } : {}),
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Language"
        title={current.name}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.3rem",
          fontSize: "0.8rem",
          padding: "0.25rem 0.4rem",
          cursor: "pointer",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
          ...(fullWidth ? { width: "100%", justifyContent: "flex-start" } : {}),
        }}
      >
        <span style={{ fontSize: "1rem", lineHeight: 1 }}>{FLAGS[current.code] ?? ""}</span>
        <span>{current.name}</span>
      </button>
      {open && (
        <div role="listbox" aria-label="Language" style={menuStyle}>
          {LOCALES.map((l) => (
            <button
              key={l.code}
              type="button"
              role="option"
              aria-selected={l.code === locale}
              className="btn btn-ghost"
              onClick={() => { setOpen(false); setLocale(l.code as Locale); }}
              style={{
                width: "100%",
                justifyContent: "flex-start",
                gap: "0.5rem",
                padding: "0.5rem 0.75rem",
                fontSize: "0.85rem",
                color: l.code === locale ? "var(--accent)" : undefined,
                background: l.code === locale ? "var(--accent-bg)" : undefined,
              }}
            >
              <span style={{ fontSize: "1rem", lineHeight: 1 }}>{FLAGS[l.code] ?? ""}</span>
              <span>{l.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}