"use client";

import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";

/**
 * Instance-style loading indicator: a Fork Awesome spinner next to the i18n
 * "loading" text. The full variant centers itself with generous padding for
 * initial screen loads; the compact variant sits inline (infinite-scroll
 * sentinels and in-progress operations).
 */
export function Loading({ text, compact = false }: { text?: string; compact?: boolean }) {
  const { t } = useLocale();
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        color: "var(--text-muted)",
        padding: compact ? "1rem" : "3rem 1rem",
        textAlign: "center",
        fontSize: compact ? "0.85rem" : "0.9rem",
      }}
    >
      <Icon name="spinner" spin size={compact ? "0.95rem" : "1.4rem"} />
      <span>{text ?? t.loading}</span>
    </div>
  );
}