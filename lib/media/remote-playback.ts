/**
 * Same-origin playback for remote audio.
 *
 * The audio waveform is a live spectrum read through Web Audio, and the spec
 * silences a media element routed into it when the resource is cross-origin
 * without CORS (`MediaElementAudioSourceNode`) — measured against cf-ap: the
 * cached copy of a remote audio file fills the analyser (max 124), its origin
 * URL returns zeros. Cached media already plays from `/api/media/...`, but a
 * remote attachment whose cache entry expired still points at its origin, so
 * its waveform stayed frozen. The player sends those through `/api/media/remote`
 * (see the route), which streams the origin from our own domain: same-origin
 * for the element, nothing stored, `Range` forwarded so seeking keeps working.
 */

export const MEDIA_RELAY_PATH = "/api/media/remote";

/** Whether the browser would load `src` from this document's own origin. */
export function isSameOriginUrl(src: string, base?: string): boolean {
  if (!src) return false;
  const documentUrl = base ?? (typeof window !== "undefined" ? window.location.href : null);
  if (!documentUrl) return false;
  try {
    return new URL(src, documentUrl).origin === new URL(documentUrl).origin;
  } catch {
    return false;
  }
}

/**
 * URL the audio element should load. Same-origin sources (local uploads, the
 * media cache) are used as they are; a cross-origin one goes through the relay.
 * The relay answers 404 for a URL it does not know, and the player then falls
 * back to the original source.
 */
export function audioPlaybackUrl(src: string): string {
  if (!src || isSameOriginUrl(src)) return src;
  // Only absolute http(s) can be relayed; data:/blob: sources stay as they are.
  if (!/^https?:\/\//i.test(src)) return src;
  return `${MEDIA_RELAY_PATH}?url=${encodeURIComponent(src)}`;
}
