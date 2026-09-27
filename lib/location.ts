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
  /** Location page of the instance that posted it (federated in the `Place`). */
  url?: string | null;
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

/** Keep a `Place`'s page URL only when it is an absolute http(s) URL. */
export function safeLocationUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString().slice(0, 500);
  } catch {
    return null;
  }
}

/** Path of the public location page, relative to the instance serving it. */
export function locationPath(location: GeoLocation): string {
  return `/locations?${locationQuery(location)}`;
}

/** Public location page (the crawler target federated in the Note). */
export function locationPageUrl(baseUrl: string, location: GeoLocation): string {
  return `${base(baseUrl)}${locationPath(location)}`;
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

/**
 * Whether a URL is a location page (`/locations?lat=…&lng=…`), regardless of
 * the instance hosting it. Used to avoid rendering the preview card when the
 * status already shows the map from its `Place`.
 */
export function isLocationPageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname.replace(/\/+$/, "") !== "/locations") return false;
    return parseLocationQuery(parsed.searchParams) !== null;
  } catch {
    return false;
  }
}

/**
 * Preview card to render for a status. A geolocated status already shows the
 * map from its `Place`, so the card of that same location page is dropped
 * (otherwise the timeline prints the map twice); cards for other links stay.
 */
export function previewCardFor<T extends { url: string }>(
  card: T | null | undefined,
  location: unknown
): T | null {
  if (!card) return null;
  if (location && isLocationPageUrl(card.url)) return null;
  return card;
}

/** Great-circle distance in meters between two points (fallback for routes). */
export function distanceMeters(a: GeoLocation, b: GeoLocation): number {
  const earthRadius = 6_371_000;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type RouteProfile = "driving" | "foot";

/** Beyond this the OSRM snap landed in another area of the road network. */
export const ROUTE_START_TOLERANCE_METERS = 25_000;

/** Beyond this the routed line does not reach the destination. */
export const ROUTE_END_TOLERANCE_METERS = 2_000;

/** Parse a `lat,lng` pair (route API query parameter). */
export function parseCoordinatePair(value: string | null): GeoLocation | null {
  if (!value) return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const latitude = Number(parts[0].trim());
  const longitude = Number(parts[1].trim());
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { name: null, latitude, longitude };
}

/**
 * Same-origin routing URL for the location page. Coordinates are rounded to
 * five decimals (~1 m) so repeated visits and profile switches hit the proxy
 * cache instead of the upstream routing service.
 */
export function routeApiUrl(
  profile: RouteProfile,
  from: GeoLocation,
  to: GeoLocation
): string {
  const pair = (point: GeoLocation) =>
    `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
  return `/api/route?profile=${profile}&from=${pair(from)}&to=${pair(to)}`;
}

/**
 * Upstream OSRM Route service URLs for a travel profile, in fallback order.
 *
 * The API (`/route/v1/{profile}/{lon},{lat};{lon},{lat}`) is the one documented
 * at https://project-osrm.org/docs/v26.6.1/http#route-service. We route on the
 * FOSSGIS community server (global OSM planet, per-profile datasets): the
 * `router.project-osrm.org` demo answers every path with the car profile, so
 * "walking" there is really a car route. The demo stays as a second attempt for
 * driving.
 */
export function routeRequestUrls(
  profile: RouteProfile,
  from: GeoLocation,
  to: GeoLocation
): string[] {
  const coordinates = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const query = "?overview=full&geometries=geojson";
  const bases =
    profile === "foot"
      ? ["https://routing.openstreetmap.de/routed-foot/route/v1/foot"]
      : [
          "https://routing.openstreetmap.de/routed-car/route/v1/driving",
          "https://router.project-osrm.org/route/v1/driving",
        ];
  return bases.map((base) => `${base}/${coordinates}${query}`);
}

/**
 * OSRM reports in `waypoints[].distance` how far the input coordinate landed
 * from the snapped one. A huge value means the server moved the point into
 * another connected component of the network — e.g. it snaps an overseas
 * address to the closest road of the continent it knows how to reach.
 */
export function routeSnapTooFar(
  snapMeters: number | null | undefined,
  toleranceMeters: number
): boolean {
  return typeof snapMeters === "number" && snapMeters > toleranceMeters;
}

/**
 * Whether a road route stops before the destination: either the geometry ends
 * far from it, or the routed distance is shorter than the direct line (which
 * roads cannot be, so the server cut the trip), e.g. Spain → Costa Rica.
 */
export function routeEndsShort(
  endGapMeters: number,
  routeDistanceMeters: number,
  directMeters: number
): boolean {
  return endGapMeters > ROUTE_END_TOLERANCE_METERS || routeDistanceMeters < directMeters * 0.9;
}

/** Human-readable label for a location (place name or rounded coordinates). */
export function locationLabel(location: GeoLocation): string {
  return location.name || `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}
