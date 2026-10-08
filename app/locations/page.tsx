import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBaseUrl } from "@/lib/cf";
import {
  locationLabel,
  locationPageUrl,
  locationParamsFromRecord,
  parseLocationQuery,
  staticLocationTileUrl,
} from "@/lib/location";
import LocationMapFull from "@/components/LocationMapFull";
import { env } from "cloudflare:workers";

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

  return <LocationMapFull location={location} />;
}
