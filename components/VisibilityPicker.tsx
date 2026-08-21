"use client";

import { useState, useEffect, useRef } from "react";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

export type Visibility = "public" | "unlisted" | "followers" | "direct";

const OPTIONS: { value: Visibility; icon: string; labelKey: "vis_public" | "vis_unlisted" | "vis_followers" | "vis_direct" }[] = [
  { value: "public", icon: "globe", labelKey: "vis_public" },
  { value: "unlisted", icon: "unlock", labelKey: "vis_unlisted" },
  { value: "followers", icon: "lock", labelKey: "vis_followers" },
  { value: "direct", icon: "envelope", labelKey: "vis_direct" },
];

interface VisibilityPickerProps {
  value: Visibility;
  onChange: (v: Visibility) => void;
  direction?: "up" | "down";
}

export function VisibilityPicker({ value, onChange, direction = "down" }: VisibilityPickerProps) {
  const { t } = useLocale();
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

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

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
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.compose_visibility}
        title={t.compose_visibility}
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
        <Icon name={current.icon} size="0.8rem" /> {t[current.labelKey]}
      </button>
      {open && (
        <div role="listbox" aria-label={t.compose_visibility} style={menuStyle}>
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className="btn btn-ghost"
              onClick={() => { setOpen(false); onChange(o.value); }}
              style={{
                width: "100%",
                justifyContent: "flex-start",
                gap: "0.5rem",
                padding: "0.5rem 0.75rem",
                fontSize: "0.85rem",
                color: o.value === value ? "var(--accent)" : undefined,
                background: o.value === value ? "var(--accent-bg)" : undefined,
              }}
            >
              <Icon name={o.icon} fixedWidth /> {t[o.labelKey]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
