"use client";

import { useState, useEffect } from "react";
import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";

/**
 * Floating "back to top" button. Appears bottom-right once the page has been
 * scrolled past the sticky sidebar (past ~60% of the viewport) and smooth
 * scrolls back to the top on click.
 */
export function BackToTop() {
  const { t } = useLocale();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > window.innerHeight * 0.6);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      aria-label={t.a11y_back_to_top}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      style={{
        position: "fixed",
        bottom: "1.25rem",
        right: "1.25rem",
        zIndex: 50,
        width: "2.75rem",
        height: "2.75rem",
        borderRadius: "50%",
        border: "1px solid var(--border)",
        background: "var(--bg-elevated)",
        color: "var(--text)",
        fontSize: "1.1rem",
        cursor: "pointer",
        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="arrow-up" />
    </button>
  );
}