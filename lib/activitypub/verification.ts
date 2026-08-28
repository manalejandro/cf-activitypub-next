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

/** Minimal KV surface used for the on-demand verification marker. */
interface VerificationKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

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

/**
 * Extract the link a field points to. Handles both a bare URL and HTML values
 * (remote actors federate fields as HTML, e.g. `<a href="https://…">…</a>`).
 */
function fieldUrl(value: string): string | null {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const href = trimmed.match(/\bhref=(["'])(.*?)\1/i)?.[2];
  if (href && /^https?:\/\//i.test(href)) return href;
  return null;
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
 * Re-check every profile field of an actor (local or remote). Clears (or sets)
 * the cached verification per field based on the rel="me" backlink check.
 * Remote actors are verified like Mastodon does — each instance runs its own
 * check against the field URL.
 */
export async function verifyAccountFields(
  db: D1Database,
  actorId: string,
  domain: string
): Promise<{ verifiedFields: number }> {
  const actor = await getActorById(db, actorId);
  if (!actor) return { verifiedFields: 0 };

  const fields = await getActorFields(db, actorId);
  if (fields.length === 0) return { verifiedFields: 0 };

  // The external page must link back to one of these profile URLs. The actor's
  // home domain (`actor.domain`) is used so remote accounts are matched against
  // their own canonical profile (e.g. https://cf-ap.com/@username); the passed
  // `domain` covers local actors / the requesting instance.
  const profileUrls = [
    normalizeUrl(`https://${actor.domain}/@${actor.username}`),
    normalizeUrl(`https://${domain}/@${actor.username}`),
    normalizeUrl(actor.id),
  ].filter(Boolean);

  let verified = 0;
  for (const field of fields) {
    const url = fieldUrl(field.value);
    if (!url || !validateOutboundUrl(url).valid) {
      await setActorFieldVerified(db, field.id, null);
      continue;
    }

    let ok = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
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
/**
 * Verify a REMOTE account on demand when it is served, guarded by a KV marker
 * so the external fetch happens at most once per hour per actor. This makes
 * the badge appear without waiting for the periodic cron.
 */
export async function maybeVerifyRemoteAccount(
  db: D1Database,
  kv: VerificationKV,
  actorId: string,
  domain: string
): Promise<void> {
  try {
    const marker = `verify:${actorId}`;
    if (await kv.get(marker)) return;

    const actor = await getActorById(db, actorId);
    if (!actor || actor.isLocal) return;

    const fields = await getActorFields(db, actorId);
    const linkFields = fields.filter((f) => fieldUrl(f.value) != null);
    // Already verified (or nothing to verify) → remember and skip.
    if (linkFields.length === 0 || linkFields.every((f) => f.verifiedAt != null)) {
      await kv.put(marker, "1", { expirationTtl: 3600 });
      return;
    }

    await verifyAccountFields(db, actorId, domain);
    await kv.put(marker, "1", { expirationTtl: 3600 });
  } catch {
    /* verification is best-effort */
  }
}
