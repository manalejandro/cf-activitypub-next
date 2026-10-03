"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { fetchLicenses, licenseName, type ClientLicense } from "@/lib/license-client";
import { LicenseBadge } from "@/components/LicenseBadge";

interface LicensePickerProps {
  /** Catalogue id of the selected license ("" = no license). */
  value: string;
  onChange: (id: string) => void;
  direction?: "up" | "down";
}

/**
 * Composer dropdown next to the visibility picker (FEP-6757): pick the license
 * for this status from the instance catalogue, or keep the default ("no
 * license": the author keeps their copyright, but federation means we cannot
 * enforce anything once the post leaves this server).
 */
export function LicensePicker({ value, onChange, direction = "down" }: LicensePickerProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [licenses, setLicenses] = useState<ClientLicense[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void fetchLicenses().then((list) => {
      if (alive) setLicenses(list);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const current = licenses.find((l) => l.id === value) ?? null;

  const menuStyle: React.CSSProperties = {
    position: "absolute",
    [direction === "down" ? "top" : "bottom"]: "calc(100% + 6px)",
    left: 0,
    zIndex: 200,
    minWidth: 240,
    maxHeight: 320,
    overflowY: "auto",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "0.25rem",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 4px 24px rgba(0,0,0,0.22)",
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.compose_license}
        title={t.compose_license}
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
          color: "var(--text)",
        }}
      >
        {current ? (
          <>
            <LicenseBadge license={current} size="0.85rem" />
            {licenseName(t, current)}
          </>
        ) : (
          <>
            <Icon name="copyright" size="0.8rem" /> {t.license_none}
          </>
        )}
      </button>
      {open && (
        <div role="listbox" aria-label={t.compose_license} style={menuStyle}>
          <button
            type="button"
            role="option"
            aria-selected={value === ""}
            className="btn btn-ghost"
            onClick={() => { setOpen(false); onChange(""); }}
            style={{
              width: "100%",
              justifyContent: "flex-start",
              gap: "0.5rem",
              padding: "0.5rem 0.75rem",
              fontSize: "0.85rem",
              color: value === "" ? "var(--accent)" : undefined,
              background: value === "" ? "var(--accent-bg)" : undefined,
            }}
          >
            <Icon name="copyright" fixedWidth /> {t.license_none}
          </button>
          <p style={{ margin: "0.25rem 0.75rem 0.5rem", fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.35 }}>
            {t.license_none_hint}
          </p>
          {licenses.map((license) => (
            <button
              key={license.id}
              type="button"
              role="option"
              aria-selected={license.id === value}
              className="btn btn-ghost"
              onClick={() => { setOpen(false); onChange(license.id); }}
              style={{
                width: "100%",
                justifyContent: "flex-start",
                gap: "0.5rem",
                padding: "0.5rem 0.75rem",
                fontSize: "0.85rem",
                color: license.id === value ? "var(--accent)" : undefined,
                background: license.id === value ? "var(--accent-bg)" : undefined,
              }}
            >
              <LicenseBadge license={license} fixedWidth />
              {licenseName(t, license)}
            </button>
          ))}
          {licenses.length > 0 && (
            <Link
              href="/licenses"
              onClick={() => setOpen(false)}
              style={{ padding: "0.4rem 0.75rem", fontSize: "0.75rem", color: "var(--text-muted)" }}
            >
              {t.compose_license_more}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
