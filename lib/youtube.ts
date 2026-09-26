/**
 * YouTube helpers shared by the link-preview crawler (server) and the web UI
 * (client). Pure and dependency-free so both bundles can import it.
 */

/** Video id of a YouTube URL (watch, youtu.be, shorts, embed). */
export function youTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
    const match = parsed.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
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
