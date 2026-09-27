import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getBaseUrl, getCloudflareContext } from "@/lib/cf";
import {
  locationLabel,
  locationPageUrl,
  locationParamsFromRecord,
  parseLocationQuery,
  staticLocationTileUrl,
} from "@/lib/location";
import LocationPreview from "@/components/LocationPreview";

/**
 * Public map page for a geolocated status.
 *
 * Federated as a `Link` attachment in the Note: Mastodon's link crawler only
 * inspects attachments (text links are ignored), follows the oEmbed discovery
 * link here and renders the map player on the remote instance. Also the target
 * of the 📍 link in the status content.
 */
async function loadLocation(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const record = await searchParams;
  return parseLocationQuery(locationParamsFromRecord(record));
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  try {
    const location = await loadLocation(searchParams);
    if (!location) return {};
    const { env } = getCloudflareContext();
    const base = getBaseUrl(env);
    const canonical = locationPageUrl(base, location);
    const title = locationLabel(location);
    const description = `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
    return {
      title,
      description,
      alternates: {
        canonical,
        types: {
          "application/json+oembed": [{ url: `${base}/api/oembed?url=${encodeURIComponent(canonical)}` }],
        },
      },
      openGraph: {
        type: "website",
        title,
        description,
        url: canonical,
        images: [{ url: staticLocationTileUrl(base, location) }],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: [staticLocationTileUrl(base, location)],
      },
    };
  } catch {
    return {};
  }
}

export default async function LocationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const location = await loadLocation(searchParams);
  if (!location) notFound();

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow)",
          padding: "1rem 1.25rem 1.25rem",
        }}
      >
        <p style={{ margin: 0, fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>
          OpenStreetMap
        </p>
        <h1 style={{ margin: "0.15rem 0 0.75rem", fontSize: "1.15rem" }}>{locationLabel(location)}</h1>
        <LocationPreview location={location} />
        <p style={{ margin: "0.75rem 0 0", fontSize: "0.8rem" }}>
          <Link
            href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=14/${location.latitude}/${location.longitude}`}
            target="_blank"
            rel="nofollow noopener noreferrer"
            style={{ color: "var(--accent)" }}
          >
            openstreetmap.org
          </Link>
        </p>
      </div>
    </main>
  );
}
