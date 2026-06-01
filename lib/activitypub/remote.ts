import type { D1Database } from "@cloudflare/workers-types";

export interface RemoteActorResult {
  id: string;
  inbox: string;
}

/**
 * Resolve the totalItems count from an AP collection field.
 * Handles three forms:
 *   - number directly (Pleroma/Misskey: followersCount)
 *   - inline collection object with totalItems
 *   - string URL → fetch the collection and read totalItems
 */
async function resolveCollectionCount(field: unknown): Promise<number> {
  if (typeof field === "number") return field;
  if (field !== null && typeof field === "object") {
    const items = (field as Record<string, unknown>).totalItems;
    if (typeof items === "number") return items;
  }
  if (typeof field === "string" && field.startsWith("http")) {
    try {
      const r = await fetch(field, {
        headers: { Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const col = await r.json() as Record<string, unknown>;
        if (typeof col.totalItems === "number") return col.totalItems;
      }
    } catch { /* ignore */ }
  }
  return 0;
}

/** Fetch a remote ActivityPub actor profile and cache it in D1. */
export async function fetchAndCacheRemoteActor(
  db: D1Database,
  actorUrl: string
): Promise<RemoteActorResult | null> {
  try {
    const res = await fetch(actorUrl, {
      headers: {
        Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const p = await res.json() as Record<string, unknown>;
    const id = (p.id as string) ?? actorUrl;
    const username = (p.preferredUsername as string) ?? "unknown";
    const urlObj = new URL(id);
    const domain = urlObj.hostname;
    const inbox = (p.inbox as string) ?? `${id}/inbox`;
    const pubKey = (p.publicKey as Record<string, string> | undefined)?.publicKeyPem ?? "";

    const usernameNorm = username.toLowerCase();

    // Fetch follower/following/outbox counts in parallel.
    // Mastodon sends these as string URLs; we fetch to get totalItems.
    const [followersCount, followingCount, statusesCount] = await Promise.all([
      resolveCollectionCount(p.followers),
      resolveCollectionCount(p.following),
      resolveCollectionCount(p.outbox),
    ]);

    // Upsert — update if already exists (in case profile changed).
    // Falls back to UPDATE by username+domain when the actor migrated to a new URL.
    try {
      await db
        .prepare(
          `INSERT INTO actors
           (id, username, domain, display_name, summary, avatar_url, header_url,
            public_key_pem, private_key_pem, is_local, is_bot,
            manually_approves_followers, discoverable,
            followers_count, following_count, statuses_count, inbox)
           VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?,1,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             summary = excluded.summary,
             avatar_url = excluded.avatar_url,
             header_url = excluded.header_url,
             public_key_pem = excluded.public_key_pem,
             manually_approves_followers = excluded.manually_approves_followers,
             discoverable = excluded.discoverable,
             followers_count = CASE WHEN excluded.followers_count > 0 THEN excluded.followers_count ELSE actors.followers_count END,
             following_count = CASE WHEN excluded.following_count > 0 THEN excluded.following_count ELSE actors.following_count END,
             statuses_count = CASE WHEN excluded.statuses_count > 0 THEN excluded.statuses_count ELSE actors.statuses_count END,
             inbox = excluded.inbox,
             updated_at = datetime('now')`
        )
        .bind(
          id, usernameNorm, domain,
          (p.name as string) ?? username,
          (p.summary as string) ?? null,
          (p.icon as Record<string, string>)?.url ?? null,
          (p.image as Record<string, string>)?.url ?? null,
          pubKey,
          (p.type as string) === "Service" ? 1 : 0,
          (p.manuallyApprovesFollowers as boolean) ? 1 : 0,
          followersCount,
          followingCount,
          statusesCount,
          inbox,
        )
        .run();
    } catch {
      // UNIQUE(username, domain) conflict — update the existing row's id so
      // subsequent getActorById(id) lookups work correctly.
      try {
        await db
          .prepare(
            `UPDATE actors SET
               id = ?, display_name = ?, summary = ?, avatar_url = ?, header_url = ?,
               public_key_pem = ?, manually_approves_followers = ?,
               followers_count = CASE WHEN ? > 0 THEN ? ELSE followers_count END,
               following_count = CASE WHEN ? > 0 THEN ? ELSE following_count END,
               statuses_count  = CASE WHEN ? > 0 THEN ? ELSE statuses_count  END,
               discoverable = ?, inbox = ?, updated_at = datetime('now')
             WHERE username = ? AND domain = ?`
          )
          .bind(
            id,
            (p.name as string) ?? username,
            (p.summary as string) ?? null,
            (p.icon as Record<string, string>)?.url ?? null,
            (p.image as Record<string, string>)?.url ?? null,
            pubKey,
            (p.manuallyApprovesFollowers as boolean) ? 1 : 0,
            followersCount,
            followersCount,
            followingCount,
            followingCount,
            statusesCount,
            statusesCount,
            1,
            inbox,
            usernameNorm,
            domain,
          )
          .run();
      } catch { /* ignore */ }
    }

    return { id, inbox };
  } catch {
    return null;
  }
}

