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
import { extractMentionHandles, type MentionsMap } from "@/lib/activitypub/content";

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

/**
 * Resolve the handles a status text mentions into link targets.
 *
 * Local handles must exist in the DB (one batched lookup) and remote ones go
 * through the cached actor or the hardened resolver (fetch + cache, with the
 * id-binding check). A handle that resolves to nothing is left out of the map,
 * so the renderer shows it as plain text instead of linking `@algo` to a local
 * profile that does not exist.
 */
export async function resolveMentionLinks(
  db: D1Database,
  text: string,
  baseUrl: string,
  kv?: KvLike | null
): Promise<MentionsMap> {
  const links: MentionsMap = new Map();
  const { local, remote } = extractMentionHandles(text);
  const localDomain = new URL(baseUrl).hostname.toLowerCase();

  const unique = [...new Set(local.map((user) => user.toLowerCase()))];
  for (let i = 0; i < unique.length; i += 90) {
    try {
      const rows = await db
        .prepare(
          `SELECT id, username FROM actors
           WHERE is_local = 1 AND username IN (SELECT value FROM json_each(?))`
        )
        .bind(JSON.stringify(unique.slice(i, i + 90)))
        .all<{ id: string; username: string }>();
      for (const row of rows.results ?? []) {
        const user = row.username.toLowerCase();
        links.set(user, { href: row.id });
        // The full local handle (`@user@ourdomain`) is the same account.
        links.set(`${user}@${localDomain}`, { href: row.id });
      }
    } catch { /* unverified mentions stay plain text */ }
  }

  for (const { user, domain } of remote) {
    const handle = user.toLowerCase();
    const host = domain.toLowerCase();
    const key = `${handle}@${host}`;
    if (links.has(key)) continue;
    const iri = await resolveMentionActorIri(db, handle, host, kv);
    if (iri) links.set(key, { href: iri });
  }

  return links;
}
