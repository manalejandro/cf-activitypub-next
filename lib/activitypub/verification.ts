/**
 * Mastodon-style account verification.
 *
 * A profile field is "verified" when its value is a URL whose page contains a
 * link back to the account's profile with `rel="me"`. The result is cached in
 * `actor_fields.verified_at` and surfaced through the API as `verified_at` on
 * the field (and a top-level `verified` flag on the account).
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getActorById, getActorFields, setActorFieldVerified } from "@/lib/db";
import { validateOutboundUrl } from "@/lib/activitypub/federation";

const FETCH_TIMEOUT_MS = 8000;

/** Lowercase scheme/host, drop hash, strip a trailing slash. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    const path = u.pathname;
    if (path !== "/" && path.endsWith("/")) u.pathname = path.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

/** A field only counts as a link when its value is a bare http(s) URL. */
function isUrlValue(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Collect hrefs of rel="me" links (both <a> and <link>) in an HTML document. */
function extractMeLinks(html: string): string[] {
  const links: string[] = [];
  const tagRe = /<(a|link)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const attrs = match[2];
    const rel = attrs.match(/\brel=(["']?)([^"' >]*)\1/i)?.[2];
    if (!rel || !rel.split(/\s+/).includes("me")) continue;
    const href = attrs.match(/\bhref=(["'])(.*?)\1/i)?.[2];
    if (href) links.push(href);
  }
  return links;
}

/**
 * Re-check every profile field of a local actor. Clears (or sets) the cached
 * verification per field based on the rel="me" backlink check.
 */
export async function verifyAccountFields(
  db: D1Database,
  actorId: string,
  domain: string
): Promise<{ verifiedFields: number }> {
  const actor = await getActorById(db, actorId);
  if (!actor || !actor.isLocal) return { verifiedFields: 0 };

  const fields = await getActorFields(db, actorId);
  if (fields.length === 0) return { verifiedFields: 0 };

  // The external page must link back to one of these profile URLs.
  const profileUrls = [
    normalizeUrl(`https://${domain}/@${actor.username}`),
    normalizeUrl(actor.id),
  ].filter(Boolean);

  let verified = 0;
  for (const field of fields) {
    const value = field.value.trim();
    if (!isUrlValue(value) || !validateOutboundUrl(value).valid) {
      await setActorFieldVerified(db, field.id, null);
      continue;
    }

    let ok = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(value, {
          headers: { Accept: "text/html, application/xhtml+xml" },
          redirect: "follow",
          signal: controller.signal,
        });
        if (res.ok) {
          const html = await res.text();
          ok = extractMeLinks(html).map(normalizeUrl).some((href) => profileUrls.includes(href));
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      ok = false;
    }

    await setActorFieldVerified(db, field.id, ok ? new Date().toISOString() : null);
    if (ok) verified++;
  }

  // Cache the account-level flag so statuses can expose the badge without
  // re-reading every field.
  await db
    .prepare("UPDATE actors SET verified = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(verified > 0 ? 1 : 0, actorId)
    .run();

  return { verifiedFields: verified };
}