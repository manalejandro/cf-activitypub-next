/**
 * Location (`as:Place`) helpers shared by the compose flow, the public
 * `/locations` page and the oEmbed provider.
 *
 * A geolocated status federates the map as a `Link` attachment pointing at our
 * own page: Mastodon's link crawler only looks at attachments with `href` (text
 * links are ignored), discovers the oEmbed player there and renders the map on
 * the remote instance.
 */

export interface GeoLocation {
  name: string | null;
  latitude: number;
  longitude: number;
}

/** Tile zoom used for the static mosaic, the OG image and the oEmbed card. */
export const LOCATION_MAP_ZOOM = 14;

function base(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function locationQuery(location: GeoLocation): string {
  const params = new URLSearchParams({
    lat: location.latitude.toFixed(6),
    lng: location.longitude.toFixed(6),
  });
  if (location.name) params.set("name", location.name.slice(0, 200));
  return params.toString();
}

/** Public location page (the crawler target federated in the Note). */
export function locationPageUrl(baseUrl: string, location: GeoLocation): string {
  return `${base(baseUrl)}/locations?${locationQuery(location)}`;
}

/** Minimal map page used as the oEmbed iframe. */
export function locationEmbedUrl(baseUrl: string, location: GeoLocation): string {
  return `${base(baseUrl)}/embed/location?${locationQuery(location)}`;
}

/** Validate `lat`/`lng`/`name` query parameters into a location, or null. */
export function parseLocationQuery(params: URLSearchParams): GeoLocation | null {
  const coord = (raw: string | null): number =>
    raw === null ? Number.NaN : Number(raw.trim().replace(",", "."));
  const latitude = coord(params.get("lat"));
  const longitude = coord(params.get("lng"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  const name = (params.get("name") ?? "").trim().slice(0, 200) || null;
  return { name, latitude, longitude };
}

/** Build a `URLSearchParams` from Next's awaited `searchParams` object. */
export function locationParamsFromRecord(
  record: Record<string, string | string[] | undefined>
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) for (const v of value) params.append(key, v);
    else if (value !== undefined) params.set(key, value);
  }
  return params;
}

// ── Slippy-map tile math (shared with LocationPreview) ──────────────────

export function tileX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * 2 ** zoom;
}

export function tileY(latitude: number, zoom: number): number {
  const rad = (latitude * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
}

/**
 * One OSM tile around the point (served through our tile proxy), used as the
 * OpenGraph image and the oEmbed thumbnail.
 */
export function staticLocationTileUrl(
  baseUrl: string,
  location: GeoLocation,
  zoom = LOCATION_MAP_ZOOM
): string {
  const max = 2 ** zoom;
  const x = (((Math.floor(tileX(location.longitude, zoom)) % max) + max) % max);
  const y = Math.min(max - 1, Math.max(0, Math.floor(tileY(location.latitude, zoom))));
  return `${base(baseUrl)}/api/map/tiles/${zoom}/${x}/${y}.png`;
}

/** Human-readable label for a location (place name or rounded coordinates). */
export function locationLabel(location: GeoLocation): string {
  return location.name || `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}
