import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { locationLabel, locationParamsFromRecord, parseLocationQuery } from "@/lib/location";
import LocationPreview from "@/components/LocationPreview";

/**
 * Minimal map page used as the oEmbed iframe on remote instances (and by our
 * own embed viewer). The `/embed/:path*` CSP allows being framed by any site.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function EmbedLocationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const record = await searchParams;
  const location = parseLocationQuery(locationParamsFromRecord(record));
  if (!location) notFound();

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "0.5rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-secondary)" }}>
        {locationLabel(location)}
      </span>
      <LocationPreview location={location} />
    </div>
  );
}
