/**
 * Visibility conversions between the internal representation and the Mastodon
 * API names.
 *
 * Internal values are what the DB, ActivityPub documents and the instance's
 * own UI use: `public | unlisted | followers | direct`. Mastodon clients speak
 * `public | unlisted | private | direct`, where `private` means followers-only.
 * Every API boundary must normalize on input and map back on output — posting
 * with `followers` used to be rejected with "Validation failed: Visibility can
 * be one of public, unlisted, private, direct".
 */

export type InternalVisibility = "public" | "unlisted" | "followers" | "direct";

const INTERNAL_VISIBILITIES: ReadonlySet<string> = new Set([
  "public",
  "unlisted",
  "followers",
  "direct",
]);

/**
 * Map a client-supplied visibility to the internal value.
 * Accepts both the internal names and the Mastodon API names (`private` →
 * `followers`). Returns null when the value is not a valid visibility.
 */
export function normalizeVisibility(raw: unknown): InternalVisibility | null {
  const v = typeof raw === "string" ? raw : "";
  if (v === "private") return "followers";
  return INTERNAL_VISIBILITIES.has(v) ? (v as InternalVisibility) : null;
}

/** Internal value → Mastodon API value (inverse of normalizeVisibility). */
export function toApiVisibility(v: string): InternalVisibility | "private" {
  return v === "followers" ? "private" : (v as InternalVisibility);
}