/**
 * YouTube helpers shared by the link-preview crawler (server) and the web UI
 * (client). Pure and dependency-free so both bundles can import it.
 */

/** Video id charset: anything else in the path (`/channel/…`, junk) is not a video. */
const VIDEO_ID = /^[A-Za-z0-9_-]+$/;

/** Video id of a YouTube URL (watch, youtu.be, shorts, embed, live). */
export function youTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    if (host === "youtu.be") {
      // `/channel/x`, `/@handle` and other non-video paths must not become ids.
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length === 1 ? videoIdOrNull(segments[0]) : null;
    }
    if (host !== "youtube.com" && host !== "youtube-nocookie.com" && host !== "music.youtube.com") {
      return null;
    }
    if (parsed.pathname === "/watch") return videoIdOrNull(parsed.searchParams.get("v"));
    // `/live/<id>` streams share the watch video id of the ended broadcast.
    const match = parsed.pathname.match(/^\/(?:shorts|embed|v|live)\/([^/?#]+)/);
    return videoIdOrNull(match?.[1]);
  } catch {
    return null;
  }
}

function videoIdOrNull(value: string | null | undefined): string | null {
  return value && VIDEO_ID.test(value) ? value : null;
}

/** CDN thumbnail for a video id (used when the watch page is walled). */
export function youTubeThumbnailUrl(videoId: string | null | undefined): string | null {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
}

/**
 * Direct oEmbed endpoint for a YouTube URL. YouTube answers oEmbed from
 * datacenter IPs even when the watch page is behind a consent/bot wall, so
 * cards can be built without crawling the page.
 */
export function youTubeOEmbedEndpoint(url: string | null | undefined): string | null {
  const videoId = youTubeVideoId(url);
  if (!videoId) return null;
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;
}

/** Privacy-enhanced embed player URL for a YouTube watch/share URL. */
export function youTubeEmbedUrlFromUrl(url: string | null | undefined): string | null {
  const videoId = youTubeVideoId(url);
  return videoId ? `https://www.youtube-nocookie.com/embed/${videoId}` : null;
}

/**
 * Validate an embeddable player URL: only the YouTube players may be framed,
 * matching the CSP `frame-src` allowlist.
 */
export function validateYouTubeEmbedUrl(embedUrl: string | null | undefined): string | null {
  if (!embedUrl) return null;
  try {
    const url = new URL(embedUrl);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "youtube-nocookie.com" && host !== "youtube.com") return null;
    if (!url.pathname.startsWith("/embed/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Embeddable player for a preview card: prefers the stored `embed_url` and
 * falls back to deriving it from the card URL, so cards crawled before the
 * fallback set `embed_url` still play.
 */
export function youTubeEmbedUrl(
  embedUrl: string | null | undefined,
  cardUrl?: string | null
): string | null {
  return validateYouTubeEmbedUrl(embedUrl) ?? youTubeEmbedUrlFromUrl(cardUrl);
}
