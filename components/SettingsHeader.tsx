"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/lib/i18n";

const TABS = [
  { href: "/settings", key: "settings_title" as const },
  { href: "/settings/push", key: "settings_tab_push" as const },
  { href: "/settings/verification", key: "settings_tab_verification" as const },
  { href: "/settings/featured-tags", key: "settings_tab_tags" as const },
  { href: "/settings/import-export", key: "settings_tab_import" as const },
  { href: "/settings/migration", key: "settings_tab_migration" as const },
  { href: "/settings/authorized-apps", key: "settings_tab_apps" as const },
  { href: "/settings/delete-account", key: "settings_tab_delete" as const },
];

/**
 * Single shared settings header: one sticky bar with the settings title and the
 * tab navigation to switch between the different settings screens. Every
 * settings page renders this instead of its own header so the tabs stay in one
 * place.
 */
export function SettingsHeader() {
  const pathname = usePathname();
  const { t } = useLocale();

  return (
    <div
      className="sticky top-0"
      style={{
        background: "var(--bg)",
        borderBottom: "1px solid var(--border)",
        padding: "1rem",
        zIndex: 10,
      }}
    >
      <h1 className="text-lg font-bold" style={{ marginBottom: "0.75rem" }}>
        {t.settings_title}
      </h1>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              style={{
                padding: "0.35rem 0.75rem",
                borderRadius: "var(--radius)",
                fontSize: "0.85rem",
                background: active ? "var(--accent-bg)" : "var(--bg-elevated)",
                color: active ? "var(--accent)" : "var(--text)",
                textDecoration: "none",
                fontWeight: active ? 700 : 400,
              }}
            >
              {t[tab.key]}
            </Link>
          );
        })}
      </div>
    </div>
  );
}