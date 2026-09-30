"use client";

import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";

/**
 * "N new statuses" pill for the timelines. It floats at the top of the column
 * (zero layout impact: the wrapper has no height) while the stream buffered
 * statuses because the reader is scrolled away from the top.
 *
 * `anchor="header"` hangs it below a sticky page header; the default sticks to
 * the viewport inside the feed itself.
 */
export default function NewStatusesPill({
  count,
  onClick,
  anchor = "flow",
}: {
  count: number;
  onClick: () => void;
  anchor?: "flow" | "header";
}) {
  const { t } = useLocale();
  if (count <= 0) return null;

  const label =
    count === 1
      ? t.timeline_new_statuses_one
      : t.timeline_new_statuses.replace("{count}", String(count));

  return (
    <div
      style={{
        position: anchor === "header" ? "absolute" : "sticky",
        ...(anchor === "header" ? { top: "100%" } : { top: "0.6rem" }),
        left: anchor === "header" ? 0 : undefined,
        right: anchor === "header" ? 0 : undefined,
        height: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        zIndex: 30,
        pointerEvents: "none",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="btn btn-primary btn-sm"
        style={{
          pointerEvents: "auto",
          borderRadius: 999,
          padding: "0.6rem 1.1rem",
          // Hanging below a sticky header needs its own breathing room; the
          // in-flow variant already sticks 0.6rem from the viewport top.
          marginTop: anchor === "header" ? "0.6rem" : undefined,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.45rem",
          boxShadow: "0 6px 18px rgba(0, 0, 0, 0.3)",
          whiteSpace: "nowrap",
        }}
      >
        <Icon name="arrow-up" size="0.8rem" color="#fff" />
        {label}
      </button>
    </div>
  );
}
