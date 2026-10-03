"use client";

import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { licenseBadges, licenseName, type ClientLicense } from "@/lib/license-client";
import { licenseI18nKey } from "@/lib/licenses";

/**
 * License detail view (FEP-6757): badges, name, localised description, the
 * canonical URI and the reminder that "no license" keeps the author's copyright
 * but federation means nobody can enforce it once the post leaves the server.
 */
export function LicenseDetail({ license, url }: { license: ClientLicense | null; url: string }) {
  const { t } = useLocale();
  const canonical = license?.url ?? url;
  const descKey = license ? licenseI18nKey(license.id, "desc") : "";
  const description = license
    ? (t as unknown as Record<string, string | undefined>)[descKey] ?? null
    : null;

  return (
    <div style={{ maxWidth: 640 }}>
      <Link href="/licenses" className="btn btn-ghost btn-sm" style={{ marginBottom: "0.75rem", gap: "0.35rem" }}>
        <Icon name="arrow-left" /> {t.license_back}
      </Link>
      <h1 style={{ fontSize: "1.4rem", display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <span style={{ display: "inline-flex", gap: "0.2rem" }}>
          {licenseBadges(license ?? { icon: "", url: canonical }).split(" ").map((icon) => (
            <Icon key={icon} name={icon} size="1.1rem" />
          ))}
        </span>
        {license ? licenseName(t, license) : canonical}
      </h1>
      {description && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "0.75rem" }}>{description}</p>
      )}
      <p style={{ marginBottom: "0.75rem" }}>
        <a href={canonical} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontSize: "0.9rem" }}>
          {t.license_view_canonical}
        </a>
      </p>
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", lineHeight: 1.5 }}>{t.license_page_intro}</p>
    </div>
  );
}
