"use client";

import { useLocale } from "@/lib/i18n";

/**
 * Shared admin table pagination. Renders nothing when there is a single page.
 */
export function Pagination({
  page,
  pages,
  onPageChange,
}: {
  page: number;
  pages: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useLocale();
  if (pages <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.75rem", padding: "1rem 0" }}>
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        {t.pagination_prev}
      </button>
      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
        {t.pagination_page.replace("{page}", String(page)).replace("{pages}", String(pages))}
      </span>
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        {t.pagination_next}
      </button>
    </div>
  );
}
