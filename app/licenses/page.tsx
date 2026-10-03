"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { PageLayout } from "@/components/PageLayout";
import { LicenseDetail } from "@/components/LicenseDetail";
import { fetchLicenses, licenseBadges, licenseName, findLicense, type ClientLicense } from "@/lib/license-client";

function LicensesContent() {
  const { t } = useLocale();
  const params = useSearchParams();
  const url = params.get("url");
  const [licenses, setLicenses] = useState<ClientLicense[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchLicenses().then((list) => {
      if (!alive) return;
      setLicenses(list);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  if (url) {
    return (
      <PageLayout>
        <div style={{ padding: "1rem" }}>
          <LicenseDetail license={findLicense(licenses, url)} url={url} />
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
    <div style={{ padding: "1rem", maxWidth: 640 }}>
      <h1 style={{ fontSize: "1.4rem", display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <Icon name="balance-scale" /> {t.license_page_title}
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", lineHeight: 1.5, marginBottom: "1rem" }}>
        {t.license_page_intro}
      </p>
      {!loaded ? null : licenses.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>{t.license_page_empty}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          {licenses.map((license) => (
            <li key={license.id}>
              <Link
                href={`/licenses?url=${encodeURIComponent(license.url)}`}
                className="btn btn-ghost"
                style={{ width: "100%", justifyContent: "flex-start", gap: "0.6rem", padding: "0.55rem 0.75rem" }}
              >
                <span style={{ display: "inline-flex", gap: "0.15rem" }}>
                  {licenseBadges(license).split(" ").map((icon) => (
                    <Icon key={icon} name={icon} fixedWidth />
                  ))}
                </span>
                {licenseName(t, license)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
    </PageLayout>
  );
}

export default function LicensesPage() {
  return (
    <Suspense fallback={null}>
      <LicensesContent />
    </Suspense>
  );
}
