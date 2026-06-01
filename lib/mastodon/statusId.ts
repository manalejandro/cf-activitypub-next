/**
 * URL-safe status ID encoding for the Mastodon API.
 *
 * AP object IRIs contain slashes which break Next.js / Cloudflare URL routing
 * when used as path segments (Cloudflare normalises %2F back to /).
 *
 * Strategy:
 *   - Local objects  (IRI = https://domain/objects/{uuid}) → return just the UUID.
 *   - Remote objects (arbitrary IRI)                       → base64url-encode the IRI.
 *
 * Both forms are URL-safe (no slashes, no problematic characters).
 */

/** Convert a full AP IRI to a URL-safe Mastodon API status ID. */
export function encodeStatusId(objectId: string, isLocal: boolean): string {
  if (isLocal) return objectId.split("/").pop() ?? objectId;
  // base64url: replace + → -, / → _, strip =
  return btoa(objectId).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode a Mastodon API status ID back to a full AP IRI.
 *
 * Handles three forms:
 *   1. UUID  → reconstructed as https://{domain}/objects/{uuid}
 *   2. base64url → decoded remote IRI
 *   3. Full IRI (legacy / backward compat) → returned as-is
 */
export function decodeStatusId(id: string, domain: string): string {
  if (UUID_RE.test(id)) return `https://${domain}/objects/${id}`;
  try {
    const decoded = atob(id.replace(/-/g, "+").replace(/_/g, "/"));
    if (decoded.startsWith("http")) return decoded;
  } catch {
    // not valid base64
  }
  // Fallback: treat as a full IRI (backward compat with old links/clients)
  return id;
}
