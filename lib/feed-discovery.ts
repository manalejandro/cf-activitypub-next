/**
 * Where a profile's feeds live.
 *
 * Local accounts are served by this instance (`/users/:username/rss|atom`).
 * A remote account's feeds live on its own server, and only Mastodon's
 * `/@user.rss` / `/@user.atom` convention is universal enough to try: both URLs
 * are probed once (KV-cached, positive results for a week, negatives for a few
 * hours) so the profile either shows a working link or none at all — a link to
 * a 404 is worse than no link.
 *
 * A suspended account gets none either way: its content is not served here, and
 * linking out to the origin would contradict the suspension.
 */

import { safeFetch } from "@/lib/activitypub/federation";
import { discardBody } from "@/lib/http";
import { externalProfileUrl } from "@/lib/remote-link";
import type { LocalActor } from "@/lib/types";

export interface ProfileFeeds {
  rss: string | null;
  atom: string | null;
}

export interface FeedDiscoveryEnv {
  KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
}

/** Positive results are stable; a negative one is retried sooner. */
const FOUND_TTL = 7 * 86400;
const MISSING_TTL = 6 * 3600;
const PROBE_TIMEOUT_MS = 4000;

/** A feed answers XML with a feed-ish content type (Mastodon: application/rss+xml). */
function looksLikeFeed(res: Response): boolean {
  const type = (res.headers.get("Content-Type") ?? "").toLowerCase();
  return res.ok && (type.includes("xml") || type.includes("rss") || type.includes("atom"));
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await safeFetch(
      url,
      { headers: { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" } },
      PROBE_TIMEOUT_MS
    );
    if (!res) return false;
    const ok = looksLikeFeed(res);
    await discardBody(res);
    return ok;
  } catch {
    return false;
  }
}

/**
 * The feeds to advertise for a profile, or null when there is none. Never
 * throws: a probe that fails (offline origin, blocked by SSRF rules, timeout)
 * simply means "no link".
 */
export async function discoverProfileFeeds(
  env: FeedDiscoveryEnv,
  actor: Pick<LocalActor, "username" | "domain" | "isLocal" | "suspended">,
  localDomain: string
): Promise<ProfileFeeds | null> {
  if (actor.suspended) return null;

  if (actor.isLocal) {
    // Mastodon's public shape (`/@username.rss`), which `proxy.ts` rewrites to
    // the feed routes: the same URL a reader would find on any other instance.
    const base = `https://${localDomain}/@${encodeURIComponent(actor.username)}`;
    return { rss: `${base}.rss`, atom: `${base}.atom` };
  }

  const acct = `${actor.username}@${actor.domain}`;
  const rss = externalProfileUrl(acct, ".rss");
  const atom = externalProfileUrl(acct, ".atom");
  if (!rss || !atom) return null;

  const cacheKey = `feeds:${acct.toLowerCase()}`;
  try {
    const cached = await env.KV?.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as ProfileFeeds;
      return parsed.rss || parsed.atom ? { rss: parsed.rss ?? null, atom: parsed.atom ?? null } : null;
    }
  } catch { /* a broken cache entry is re-probed */ }

  const [hasRss, hasAtom] = await Promise.all([probe(rss), probe(atom)]);
  const found: ProfileFeeds = { rss: hasRss ? rss : null, atom: hasAtom ? atom : null };
  try {
    await env.KV?.put(cacheKey, JSON.stringify(found), {
      expirationTtl: hasRss || hasAtom ? FOUND_TTL : MISSING_TTL,
    });
  } catch { /* cache is best-effort */ }

  return hasRss || hasAtom ? found : null;
}
