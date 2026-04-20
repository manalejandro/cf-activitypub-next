import type { D1Database } from "@cloudflare/workers-types";
import type {
  LocalActor,
  LocalObject,
  LocalFollow,
  LocalLike,
  LocalAnnounce,
  LocalNotification,
  OAuthApp,
  OAuthToken,
} from "@/lib/types";

// ─────────────────────────────────────────
// Actors
// ─────────────────────────────────────────

export async function getActorById(db: D1Database, id: string): Promise<LocalActor | null> {
  const row = await db.prepare("SELECT * FROM actors WHERE id = ?").bind(id).first<LocalActor>();
  return row ?? null;
}

export async function getActorByUsername(
  db: D1Database,
  username: string,
  domain: string
): Promise<LocalActor | null> {
  const row = await db
    .prepare("SELECT * FROM actors WHERE username = ? AND domain = ?")
    .bind(username.toLowerCase(), domain.toLowerCase())
    .first<LocalActor>();
  return row ?? null;
}

export async function getActorByEmail(db: D1Database, email: string): Promise<LocalActor | null> {
  const row = await db
    .prepare("SELECT * FROM actors WHERE email = ?")
    .bind(email.toLowerCase())
    .first<LocalActor>();
  return row ?? null;
}

export async function createActor(db: D1Database, actor: Omit<LocalActor, "createdAt" | "updatedAt">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (
        id, username, domain, display_name, summary, avatar_url, header_url,
        public_key_pem, private_key_pem, is_local, is_bot,
        manually_approves_followers, discoverable,
        followers_count, following_count, statuses_count,
        email, password_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      actor.id,
      actor.username.toLowerCase(),
      actor.domain.toLowerCase(),
      actor.displayName,
      actor.summary,
      actor.avatarUrl,
      actor.headerUrl,
      actor.publicKeyPem,
      actor.privateKeyPem,
      actor.isLocal ? 1 : 0,
      actor.isBot ? 1 : 0,
      actor.manuallyApprovesFollowers ? 1 : 0,
      actor.discoverable ? 1 : 0,
      actor.followersCount,
      actor.followingCount,
      actor.statusesCount,
      actor.email ?? null,
      actor.passwordHash ?? null
    )
    .run();
}

export async function updateActor(
  db: D1Database,
  id: string,
  fields: Partial<LocalActor>
): Promise<void> {
  const allowed = [
    "display_name",
    "summary",
    "avatar_url",
    "header_url",
    "public_key_pem",
    "followers_count",
    "following_count",
    "statuses_count",
    "discoverable",
    "manually_approves_followers",
  ] as const;

  const map: Record<string, string> = {
    displayName: "display_name",
    summary: "summary",
    avatarUrl: "avatar_url",
    headerUrl: "header_url",
    publicKeyPem: "public_key_pem",
    followersCount: "followers_count",
    followingCount: "following_count",
    statusesCount: "statuses_count",
    discoverable: "discoverable",
    manuallyApprovesFollowers: "manually_approves_followers",
  };

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [jsKey, sqlKey] of Object.entries(map)) {
    if (jsKey in fields) {
      setClauses.push(`${sqlKey} = ?`);
      const v = (fields as Record<string, unknown>)[jsKey];
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
  }

  if (setClauses.length === 0) return;
  setClauses.push("updated_at = datetime('now')");
  values.push(id);

  await db
    .prepare(`UPDATE actors SET ${setClauses.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

// ─────────────────────────────────────────
// Objects / Statuses
// ─────────────────────────────────────────

export async function getObjectById(db: D1Database, id: string): Promise<LocalObject | null> {
  const row = await db.prepare("SELECT * FROM objects WHERE id = ?").bind(id).first<LocalObject>();
  return row ?? null;
}

export async function createObject(db: D1Database, obj: Omit<LocalObject, "updatedAt">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (
        id, type, actor_id, content, content_warning, sensitive,
        visibility, in_reply_to_id, language, url,
        replies_count, reblogs_count, favourites_count,
        published, is_local, raw
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      obj.id,
      obj.type,
      obj.actorId,
      obj.content ?? null,
      obj.contentWarning ?? null,
      obj.sensitive ? 1 : 0,
      obj.visibility,
      obj.inReplyToId ?? null,
      obj.language ?? null,
      obj.url,
      obj.repliesCount,
      obj.reblogsCount,
      obj.favouritesCount,
      obj.published,
      obj.local ? 1 : 0,
      obj.raw
    )
    .run();
}

export async function getPublicTimeline(
  db: D1Database,
  limit = 20,
  maxId?: string
): Promise<LocalObject[]> {
  let q = db.prepare(
    `SELECT o.* FROM objects o
     WHERE o.visibility = 'public' AND o.is_local = 1
     ORDER BY o.published DESC LIMIT ?`
  );
  if (maxId) {
    q = db.prepare(
      `SELECT o.* FROM objects o
       WHERE o.visibility = 'public' AND o.is_local = 1
         AND o.published < (SELECT published FROM objects WHERE id = ?)
       ORDER BY o.published DESC LIMIT ?`
    );
    return (await q.bind(maxId, limit).all<LocalObject>()).results;
  }
  return (await q.bind(limit).all<LocalObject>()).results;
}

export async function getHomeTimeline(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string
): Promise<LocalObject[]> {
  const baseWhere = `
    o.visibility IN ('public', 'unlisted')
    AND (
      o.actor_id = ?
      OR o.actor_id IN (
        SELECT target_id FROM follows WHERE actor_id = ? AND state = 'accepted'
      )
    )
  `;
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE ${baseWhere}
           AND o.published < (SELECT published FROM objects WHERE id = ?)
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(actorId, actorId, maxId, limit)
      .all<LocalObject>();
    return rows.results;
  }
  const rows = await db
    .prepare(`SELECT o.* FROM objects o WHERE ${baseWhere} ORDER BY o.published DESC LIMIT ?`)
    .bind(actorId, actorId, limit)
    .all<LocalObject>();
  return rows.results;
}

export async function getActorStatuses(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string
): Promise<LocalObject[]> {
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT * FROM objects WHERE actor_id = ?
         AND published < (SELECT published FROM objects WHERE id = ?)
         ORDER BY published DESC LIMIT ?`
      )
      .bind(actorId, maxId, limit)
      .all<LocalObject>();
    return rows.results;
  }
  const rows = await db
    .prepare("SELECT * FROM objects WHERE actor_id = ? ORDER BY published DESC LIMIT ?")
    .bind(actorId, limit)
    .all<LocalObject>();
  return rows.results;
}

export async function deleteObject(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM objects WHERE id = ?").bind(id).run();
}

// ─────────────────────────────────────────
// Follows
// ─────────────────────────────────────────

export async function getFollow(
  db: D1Database,
  actorId: string,
  targetId: string
): Promise<LocalFollow | null> {
  const row = await db
    .prepare("SELECT * FROM follows WHERE actor_id = ? AND target_id = ?")
    .bind(actorId, targetId)
    .first<LocalFollow>();
  return row ?? null;
}

export async function createFollow(db: D1Database, follow: LocalFollow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO follows (id, actor_id, target_id, state, activity_id) VALUES (?,?,?,?,?)"
    )
    .bind(follow.id, follow.actorId, follow.targetId, follow.state, follow.activityId ?? null)
    .run();
}

export async function updateFollowState(
  db: D1Database,
  id: string,
  state: "accepted" | "rejected"
): Promise<void> {
  await db.prepare("UPDATE follows SET state = ? WHERE id = ?").bind(state, id).run();
}

export async function deleteFollow(db: D1Database, actorId: string, targetId: string): Promise<void> {
  await db
    .prepare("DELETE FROM follows WHERE actor_id = ? AND target_id = ?")
    .bind(actorId, targetId)
    .run();
}

export async function getFollowers(
  db: D1Database,
  targetId: string,
  limit = 40,
  offset = 0
): Promise<LocalActor[]> {
  const rows = await db
    .prepare(
      `SELECT a.* FROM actors a
       JOIN follows f ON f.actor_id = a.id
       WHERE f.target_id = ? AND f.state = 'accepted'
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(targetId, limit, offset)
    .all<LocalActor>();
  return rows.results;
}

export async function getFollowing(
  db: D1Database,
  actorId: string,
  limit = 40,
  offset = 0
): Promise<LocalActor[]> {
  const rows = await db
    .prepare(
      `SELECT a.* FROM actors a
       JOIN follows f ON f.target_id = a.id
       WHERE f.actor_id = ? AND f.state = 'accepted'
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(actorId, limit, offset)
    .all<LocalActor>();
  return rows.results;
}

// ─────────────────────────────────────────
// Likes
// ─────────────────────────────────────────

export async function getLike(db: D1Database, actorId: string, objectId: string): Promise<LocalLike | null> {
  const row = await db
    .prepare("SELECT * FROM likes WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .first<LocalLike>();
  return row ?? null;
}

export async function createLike(db: D1Database, like: LocalLike): Promise<void> {
  await db
    .prepare("INSERT INTO likes (id, actor_id, object_id, activity_id) VALUES (?,?,?,?)")
    .bind(like.id, like.actorId, like.objectId, like.activityId)
    .run();
  await db
    .prepare("UPDATE objects SET favourites_count = favourites_count + 1 WHERE id = ?")
    .bind(like.objectId)
    .run();
}

export async function deleteLike(db: D1Database, actorId: string, objectId: string): Promise<void> {
  await db
    .prepare("DELETE FROM likes WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .run();
  await db
    .prepare("UPDATE objects SET favourites_count = MAX(0, favourites_count - 1) WHERE id = ?")
    .bind(objectId)
    .run();
}

// ─────────────────────────────────────────
// Announces (boosts)
// ─────────────────────────────────────────

export async function getAnnounce(
  db: D1Database,
  actorId: string,
  objectId: string
): Promise<LocalAnnounce | null> {
  const row = await db
    .prepare("SELECT * FROM announces WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .first<LocalAnnounce>();
  return row ?? null;
}

export async function createAnnounce(db: D1Database, announce: LocalAnnounce): Promise<void> {
  await db
    .prepare("INSERT INTO announces (id, actor_id, object_id, activity_id) VALUES (?,?,?,?)")
    .bind(announce.id, announce.actorId, announce.objectId, announce.activityId)
    .run();
  await db
    .prepare("UPDATE objects SET reblogs_count = reblogs_count + 1 WHERE id = ?")
    .bind(announce.objectId)
    .run();
}

export async function deleteAnnounce(db: D1Database, actorId: string, objectId: string): Promise<void> {
  await db
    .prepare("DELETE FROM announces WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .run();
  await db
    .prepare("UPDATE objects SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?")
    .bind(objectId)
    .run();
}

// ─────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────

export async function createNotification(db: D1Database, notif: LocalNotification): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, type, account_id, target_account_id, object_id, is_read)
       VALUES (?,?,?,?,?,?)`
    )
    .bind(notif.id, notif.type, notif.accountId, notif.targetAccountId, notif.objectId ?? null, 0)
    .run();
}

export async function getNotifications(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string
): Promise<LocalNotification[]> {
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT * FROM notifications
         WHERE target_account_id = ?
           AND created_at < (SELECT created_at FROM notifications WHERE id = ?)
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(actorId, maxId, limit)
      .all<LocalNotification>();
    return rows.results;
  }
  const rows = await db
    .prepare(
      "SELECT * FROM notifications WHERE target_account_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .bind(actorId, limit)
    .all<LocalNotification>();
  return rows.results;
}

// ─────────────────────────────────────────
// OAuth
// ─────────────────────────────────────────

export async function createOAuthApp(db: D1Database, app: OAuthApp): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_apps (id, name, website, redirect_uri, scopes, client_id, client_secret)
       VALUES (?,?,?,?,?,?,?)`
    )
    .bind(app.id, app.name, app.website ?? null, app.redirectUri, app.scopes, app.clientId, app.clientSecret)
    .run();
}

export async function getOAuthAppByClientId(db: D1Database, clientId: string): Promise<OAuthApp | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_apps WHERE client_id = ?")
    .bind(clientId)
    .first<OAuthApp>();
  return row ?? null;
}

export async function createOAuthToken(db: D1Database, token: OAuthToken): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, refresh_token, scope, expires_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .bind(token.id, token.actorId ?? null, token.appId, token.accessToken, token.refreshToken ?? null, token.scope, token.expiresAt ?? null)
    .run();
}

export async function getTokenByAccessToken(db: D1Database, token: string): Promise<OAuthToken | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_tokens WHERE access_token = ?")
    .bind(token)
    .first<OAuthToken>();
  return row ?? null;
}
