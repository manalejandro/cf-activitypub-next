"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
import { PageLayout } from "@/components/PageLayout";
import { LicenseDetail } from "@/components/LicenseDetail";
import { fetchLicenses, type ClientLicense } from "@/lib/license-client";

/** Pretty URL for a catalogue entry: /licenses/<id>. */
export default function LicenseByIdPage() {
  const { t } = useLocale();
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
  const [license, setLicense] = useState<ClientLicense | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchLicenses().then((list) => {
      if (!alive) return;
      setLicense(list.find((l) => l.id === id) ?? null);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [id]);

  if (!loaded) return null;
  if (!license) {
    return (
      <PageLayout>
        <p style={{ color: "var(--text-muted)", padding: "1rem" }}>{t.license_not_found}</p>
      </PageLayout>
    );
  }
  return (
    <PageLayout>
      <div style={{ padding: "1rem" }}>
        <LicenseDetail license={license} url={license.url} />
      </div>
    </PageLayout>
  );
}
