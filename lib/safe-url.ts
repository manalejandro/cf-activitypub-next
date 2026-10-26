/**
 * URL safety for values that come out of a federated document and end up in an
 * `href`/`src` attribute, a media player or an `<iframe>`.
 *
 * A remote server controls `attachment.url`, the Emoji tag's `icon.url` and an
 * object's `url`; none of them were validated on the way in, and the renderers
 * interpolate them straight into HTML/attributes (`javascript:`, `data:` and a
 * bare `"` all break out). Every one of those values goes through here.
 */

/** Absolute http(s) URL, normalized, or null. `max` bounds what we store/serve. */
export function safeHttpUrl(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString().slice(0, max);
  } catch {
    return null;
  }
}

/** Like `safeHttpUrl` but https-only (federation, push endpoints, embeds). */
export function safeHttpsUrl(value: unknown, max = 2000): string | null {
  const url = safeHttpUrl(value, max);
  return url && url.startsWith("https://") ? url : null;
}

/**
 * Media we serve ourselves keeps its relative path (`/api/media/...`); anything
 * else must be an absolute http(s) URL. `//host/x` is rejected: browsers read it
 * as protocol-relative — and so is `/\host/x`, whose backslash the browser
 * normalizes into a slash when navigating.
 */
export function safeMediaUrl(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\")) {
    return trimmed.slice(0, max);
  }
  return safeHttpUrl(trimmed, max);
}

/**
 * Same-origin navigation target for `?redirect=` parameters. String shape
 * checks are not enough: `/\evil.com` looks like a path, but browsers
 * normalize the backslash when navigating and leave the origin, and
 * `//evil.com` is protocol-relative. Resolving against `origin` catches every
 * shape; anything that does not come back to the same origin becomes
 * `fallback`.
 */
export function sameOriginRedirect(
  raw: string | null | undefined,
  origin: string,
  fallback = "/home"
): string {
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw, origin);
    if (parsed.origin !== new URL(origin).origin) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
