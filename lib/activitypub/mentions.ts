/**
 * Canonical mention resolution.
 *
 * `processStatusContent` linkifies mentions without DB access, so a remote
 * mention can only be rendered as the web profile (`https://domain/@user`).
 * ActivityPub peers match mentions by actor id: a `/@user` href silently skips
 * the mention notification on the target (and, when the peer does not serve
 * the actor at the profile URL, the delivery too). Before building the Note,
 * every text-parsed remote mention is rewritten to the mentioned actor's
 * canonical IRI.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { APTag } from "@/lib/types";
import { getActorByUsername } from "@/lib/db";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";

type KvLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export interface CanonicalMentions {
  /** Tags with remote mention hrefs rewritten to the actors' IRIs. */
  tags: APTag[];
  /** href → canonical IRI, for rewriting `to`/`cc` lists too. */
  rewrites: Map<string, string>;
}

/**
 * Rewrite text-parsed remote mention tags (`https://domain/@user`) to the
 * mentioned actor's canonical IRI. Cached actors resolve offline; unknown ones
 * go through the hardened actor resolver (profile URL → same-host canonical
 * id, with the id-binding check). Unresolvable handles keep the profile URL so
 * the status is never lost.
 */
export async function canonicalizeMentionTags(
  db: D1Database,
  tags: APTag[],
  kv?: KvLike | null
): Promise<CanonicalMentions> {
  const rewrites = new Map<string, string>();
  const out: APTag[] = [];
  for (const tag of tags) {
    if (tag.type !== "Mention" || !tag.href) {
      out.push(tag);
      continue;
    }
    const match = /^https?:\/\/([^/]+)\/@([^/@]+)$/.exec(tag.href);
    if (!match) {
      out.push(tag);
      continue;
    }
    const canonical = await resolveMentionActorIri(db, match[2], match[1], kv);
    if (!canonical || canonical === tag.href) {
      out.push(tag);
      continue;
    }
    rewrites.set(tag.href, canonical);
    out.push({ ...tag, href: canonical });
  }
  return { tags: out, rewrites };
}

async function resolveMentionActorIri(
  db: D1Database,
  username: string,
  domain: string,
  kv?: KvLike | null
): Promise<string | null> {
  const handle = username.toLowerCase();
  try {
    const cached = await getActorByUsername(db, handle, domain);
    if (cached) return cached.id;
  } catch { /* fall through to the network resolver */ }
  try {
    const resolved = await fetchAndCacheRemoteActor(db, `https://${domain}/@${handle}`, kv ?? undefined);
    return resolved?.id ?? null;
  } catch {
    return null;
  }
}
