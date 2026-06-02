import type { D1Database } from "@cloudflare/workers-types";
import type {
  LocalActor,
  ActorField,
  LocalObject,
  LocalFollow,
  LocalLike,
  LocalAnnounce,
  LocalNotification,
  LocalAttachment,
  LocalPoll,
  LocalPollOption,
  OAuthApp,
  OAuthToken,
  APActor,
} from "@/lib/types";

// ─────────────────────────────────────────
// Row mappers — D1 returns snake_case column names; convert to camelCase
// ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface EmailVerification {
  id: string;
  actorId: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

function rowToActor(r: Row): LocalActor {
  return {
    id: r.id,
    username: r.username,
    domain: r.domain,
    displayName: r.display_name ?? null,
    summary: r.summary ?? null,
    avatarUrl: r.avatar_url ?? null,
    headerUrl: r.header_url ?? null,
    publicKeyPem: r.public_key_pem,
    privateKeyPem: r.private_key_pem ?? null,
    isLocal: Boolean(r.is_local),
    isBot: Boolean(r.is_bot),
    manuallyApprovesFollowers: Boolean(r.manually_approves_followers),
    discoverable: Boolean(r.discoverable),
    followersCount: r.followers_count ?? 0,
    followingCount: r.following_count ?? 0,
    statusesCount: r.statuses_count ?? 0,
    email: r.email ?? null,
    passwordHash: r.password_hash ?? null,
    emailVerified: Boolean(r.email_verified),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    inbox: r.inbox ?? null,
    autoDeleteAfter: r.auto_delete_after ?? null,
  };
}

function rowToField(r: Row): ActorField {
  return {
    id: r.id,
    actorId: r.actor_id,
    name: r.name,
    value: r.value,
    position: r.position ?? 0,
    createdAt: r.created_at,
  };
}

function rowToObject(r: Row): LocalObject {
  return {
    id: r.id,
    type: r.type,
    actorId: r.actor_id,
    content: r.content ?? null,
    contentWarning: r.content_warning ?? null,
    sensitive: Boolean(r.sensitive),
    visibility: r.visibility,
    inReplyToId: r.in_reply_to_id ?? null,
    language: r.language ?? null,
    url: r.url,
    repliesCount: r.replies_count ?? 0,
    reblogsCount: r.reblogs_count ?? 0,
    favouritesCount: r.favourites_count ?? 0,
    published: r.published,
    updatedAt: r.updated_at,
    local: Boolean(r.is_local),
    raw: r.raw ?? "{}",
  };
}

function rowToApp(r: Row): OAuthApp {
  return {
    id: r.id,
    name: r.name,
    website: r.website ?? null,
    redirectUri: r.redirect_uri,
    scopes: r.scopes,
    clientId: r.client_id,
    clientSecret: r.client_secret,
    createdAt: r.created_at,
  };
}

function rowToToken(r: Row): OAuthToken {
  return {
    id: r.id,
    actorId: r.actor_id ?? null,
    appId: r.app_id ?? null,
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    scope: r.scope,
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
  };
}

function rowToFollow(r: Row): LocalFollow {
  return {
    id: r.id,
    actorId: r.actor_id,
    targetId: r.target_id,
    state: r.state,
    activityId: r.activity_id ?? null,
    createdAt: r.created_at,
  };
}

function rowToLike(r: Row): LocalLike {
  return {
    id: r.id,
    actorId: r.actor_id,
    objectId: r.object_id,
    activityId: r.activity_id,
    createdAt: r.created_at,
  };
}

function rowToAnnounce(r: Row): LocalAnnounce {
  return {
    id: r.id,
    actorId: r.actor_id,
    objectId: r.object_id,
    activityId: r.activity_id,
    createdAt: r.created_at,
  };
}

function rowToNotification(r: Row): LocalNotification {
  return {
    id: r.id,
    type: r.type,
    accountId: r.account_id,
    targetAccountId: r.target_account_id,
    objectId: r.object_id ?? null,
    read: Boolean(r.is_read),
    createdAt: r.created_at,
  };
}

function rowToAttachment(r: Row): LocalAttachment {
  return {
    id: r.id,
    objectId: r.object_id,
    type: r.type ?? "image",
    url: r.url,
    remoteUrl: r.remote_url ?? null,
    description: r.description ?? null,
    blurhash: r.blurhash ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    fileSize: r.file_size ?? null,
    mimeType: r.mime_type ?? null,
    createdAt: r.created_at,
  };
}

// ─────────────────────────────────────────
// Actors
// ─────────────────────────────────────────

export async function getActorById(db: D1Database, id: string): Promise<LocalActor | null> {
  const row = await db.prepare("SELECT * FROM actors WHERE id = ?").bind(id).first<Row>();
  return row ? rowToActor(row) : null;
}

export async function getActorByUsername(
  db: D1Database,
  username: string,
  domain: string
): Promise<LocalActor | null> {
  const row = await db
    .prepare("SELECT * FROM actors WHERE username = ? AND domain = ?")
    .bind(username.toLowerCase(), domain.toLowerCase())
    .first<Row>();
  return row ? rowToActor(row) : null;
}

export async function getActorByEmail(db: D1Database, email: string): Promise<LocalActor | null> {
  const row = await db
    .prepare("SELECT * FROM actors WHERE email = ?")
    .bind(email.toLowerCase())
    .first<Row>();
  return row ? rowToActor(row) : null;
}

export async function createActor(db: D1Database, actor: Omit<LocalActor, "createdAt" | "updatedAt">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (
        id, username, domain, display_name, summary, avatar_url, header_url,
        public_key_pem, private_key_pem, is_local, is_bot,
        manually_approves_followers, discoverable,
        followers_count, following_count, statuses_count,
        email, password_hash, email_verified
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      actor.passwordHash ?? null,
      actor.emailVerified ? 1 : 0
    )
    .run();
}

/**
 * Upsert a remote actor — inserts on first encounter, updates on subsequent
 * fetches (e.g. key rotation, profile changes). Preserves local-only fields.
 */
export async function upsertRemoteActor(db: D1Database, actor: APActor): Promise<void> {
  const domain = new URL(actor.id).hostname;
  const username = (actor.preferredUsername ?? "").toLowerCase();
  try {
    await db
      .prepare(
        `INSERT INTO actors (
          id, username, domain, display_name, summary, avatar_url, header_url,
          public_key_pem, private_key_pem, is_local, is_bot,
          manually_approves_followers, discoverable,
          followers_count, following_count, statuses_count, inbox
        ) VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?,?,0,0,0,?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          summary = excluded.summary,
          avatar_url = excluded.avatar_url,
          header_url = excluded.header_url,
          public_key_pem = excluded.public_key_pem,
          is_bot = excluded.is_bot,
          manually_approves_followers = excluded.manually_approves_followers,
          discoverable = excluded.discoverable,
          inbox = excluded.inbox,
          updated_at = datetime('now')`
      )
      .bind(
        actor.id,
        username,
        domain,
        actor.name ?? null,
        actor.summary ?? null,
        actor.icon?.url ?? null,
        actor.image?.url ?? null,
        actor.publicKey.publicKeyPem,
        actor.type === "Service" ? 1 : 0,
        actor.manuallyApprovesFollowers ? 1 : 0,
        actor.discoverable !== false ? 1 : 0,
        actor.inbox
      )
      .run();
  } catch {
    // UNIQUE(username, domain) conflict — actor may have migrated to a new URL.
    // Update the existing row's id so getActorById(actor.id) works after this call.
    try {
      await db
        .prepare(
          `UPDATE actors SET
            id = ?, display_name = ?, summary = ?, avatar_url = ?, header_url = ?,
            public_key_pem = ?, is_bot = ?, manually_approves_followers = ?,
            discoverable = ?, inbox = ?, updated_at = datetime('now')
          WHERE username = ? AND domain = ?`
        )
        .bind(
          actor.id,
          actor.name ?? null,
          actor.summary ?? null,
          actor.icon?.url ?? null,
          actor.image?.url ?? null,
          actor.publicKey.publicKeyPem,
          actor.type === "Service" ? 1 : 0,
          actor.manuallyApprovesFollowers ? 1 : 0,
          actor.discoverable !== false ? 1 : 0,
          actor.inbox,
          username,
          domain
        )
        .run();
    } catch { /* ignore */ }
  }
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
    autoDeleteAfter: "auto_delete_after",
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
  const row = await db.prepare("SELECT * FROM objects WHERE id = ?").bind(id).first<Row>();
  return row ? rowToObject(row) : null;
}

export async function createObject(db: D1Database, obj: Omit<LocalObject, "updatedAt">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (
        id, type, actor_id, content, content_warning, sensitive,
        visibility, in_reply_to_id, language, url,
        replies_count, reblogs_count, favourites_count,
        published, is_local, raw, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      obj.raw,
      obj.published   // pin updated_at = published so new posts never appear as edited
    )
    .run();
}

export async function getPublicTimeline(
  db: D1Database,
  limit = 20,
  maxId?: string,
  local = false,
  sinceId?: string
): Promise<LocalObject[]> {
  // local=true  → only statuses from this instance
  // local=false → all public statuses (federated timeline)
  const localFilter = local ? "AND o.is_local = 1" : "";
  if (sinceId) {
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE o.visibility = 'public' ${localFilter}
           AND o.published > (SELECT published FROM objects WHERE id = ?)
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(sinceId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE o.visibility = 'public' ${localFilter}
           AND o.published < (SELECT published FROM objects WHERE id = ?)
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(maxId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(
      `SELECT o.* FROM objects o
       WHERE o.visibility = 'public' ${localFilter}
       ORDER BY o.published DESC LIMIT ?`
    )
    .bind(limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

export async function getHomeTimeline(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string
): Promise<LocalObject[]> {
  // Own posts → all visibilities (except direct).
  // Posts from followed accounts → public, unlisted, followers-only.
  // Direct messages are excluded (handled through conversations).
  const baseWhere = `
    (
      (o.actor_id = ? AND o.visibility != 'direct')
      OR (
        o.actor_id IN (
          SELECT target_id FROM follows WHERE actor_id = ? AND state = 'accepted'
        )
        AND o.visibility IN ('public', 'unlisted', 'followers')
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
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(`SELECT o.* FROM objects o WHERE ${baseWhere} ORDER BY o.published DESC LIMIT ?`)
    .bind(actorId, actorId, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

export async function getHashtagTimeline(
  db: D1Database,
  hashtag: string,
  limit = 20,
  maxId?: string
): Promise<LocalObject[]> {
  // Search the raw AP JSON for Hashtag tag entries matching the given hashtag name.
  // LIKE is case-insensitive for ASCII in SQLite, so #test matches #Test etc.
  const likePattern = `%"name":"#${hashtag.toLowerCase()}"%`;
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE o.visibility IN ('public', 'unlisted')
           AND o.raw LIKE ?
           AND o.published < (SELECT published FROM objects WHERE id = ?)
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(likePattern, maxId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(
      `SELECT o.* FROM objects o
       WHERE o.visibility IN ('public', 'unlisted')
         AND o.raw LIKE ?
       ORDER BY o.published DESC LIMIT ?`
    )
    .bind(likePattern, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
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
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare("SELECT * FROM objects WHERE actor_id = ? ORDER BY published DESC LIMIT ?")
    .bind(actorId, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

export async function updateObject(
  db: D1Database,
  id: string,
  fields: { content?: string; contentWarning?: string | null; sensitive?: boolean; language?: string | null; raw?: string }
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if ("content" in fields) { setClauses.push("content = ?"); values.push(fields.content ?? null); }
  if ("contentWarning" in fields) { setClauses.push("content_warning = ?"); values.push(fields.contentWarning ?? null); }
  if ("sensitive" in fields) { setClauses.push("sensitive = ?"); values.push(fields.sensitive ? 1 : 0); }
  if ("language" in fields) { setClauses.push("language = ?"); values.push(fields.language ?? null); }
  if ("raw" in fields) { setClauses.push("raw = ?"); values.push(fields.raw); }

  if (setClauses.length === 0) return;
  setClauses.push("updated_at = datetime('now')");
  values.push(id);

  await db
    .prepare(`UPDATE objects SET ${setClauses.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
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
    .first<Row>();
  return row ? rowToFollow(row) : null;
}

export async function createFollow(db: D1Database, follow: LocalFollow): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO follows (id, actor_id, target_id, state, activity_id, created_at) VALUES (?,?,?,?,?,?)"
    )
    .bind(
      follow.id,
      follow.actorId,
      follow.targetId,
      follow.state,
      follow.activityId ?? null,
      follow.createdAt ?? new Date().toISOString()
    )
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
    .all<Row>();
  return rows.results.map(rowToActor);
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
    .all<Row>();
  return rows.results.map(rowToActor);
}

// ─────────────────────────────────────────
// Likes
// ─────────────────────────────────────────

export async function getLike(db: D1Database, actorId: string, objectId: string): Promise<LocalLike | null> {
  const row = await db
    .prepare("SELECT * FROM likes WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .first<Row>();
  return row ? rowToLike(row) : null;
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
    .first<Row>();
  return row ? rowToAnnounce(row) : null;
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
      .all<Row>();
    return rows.results.map(rowToNotification);
  }
  const rows = await db
    .prepare(
      "SELECT * FROM notifications WHERE target_account_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .bind(actorId, limit)
    .all<Row>();
  return rows.results.map(rowToNotification);
}

export async function getUnreadNotificationCount(db: D1Database, actorId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as cnt FROM notifications WHERE target_account_id = ? AND is_read = 0")
    .bind(actorId)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

export async function markNotificationsRead(db: D1Database, actorId: string): Promise<void> {
  await db
    .prepare("UPDATE notifications SET is_read = 1 WHERE target_account_id = ? AND is_read = 0")
    .bind(actorId)
    .run();
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
    .first<Row>();
  return row ? rowToApp(row) : null;
}

export async function createOAuthToken(db: D1Database, token: OAuthToken): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, refresh_token, scope, expires_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .bind(token.id, token.actorId ?? null, token.appId ?? null, token.accessToken, token.refreshToken ?? null, token.scope, token.expiresAt ?? null)
    .run();
}

export async function getTokenByAccessToken(db: D1Database, token: string): Promise<OAuthToken | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_tokens WHERE access_token = ?")
    .bind(token)
    .first<Row>();
  return row ? rowToToken(row) : null;
}

// ─────────────────────────────────────────
// Attachments
// ─────────────────────────────────────────

export async function createAttachment(db: D1Database, att: LocalAttachment): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attachments (id, object_id, type, url, remote_url, description, blurhash, width, height, file_size, mime_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      att.id,
      att.objectId,
      att.type,
      att.url,
      att.remoteUrl ?? null,
      att.description ?? null,
      att.blurhash ?? null,
      att.width ?? null,
      att.height ?? null,
      att.fileSize ?? null,
      att.mimeType ?? null
    )
    .run();
}

export async function getAttachmentsByObjectId(
  db: D1Database,
  objectId: string
): Promise<LocalAttachment[]> {
  const rows = await db
    .prepare("SELECT * FROM attachments WHERE object_id = ? ORDER BY created_at ASC")
    .bind(objectId)
    .all<Row>();
  return rows.results.map(rowToAttachment);
}

/** Fetch attachments for many objects in a single query. Returns a Map from object_id → attachments. */
export async function getAttachmentsByObjectIds(
  db: D1Database,
  objectIds: string[]
): Promise<Map<string, LocalAttachment[]>> {
  if (objectIds.length === 0) return new Map();
  const placeholders = objectIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT * FROM attachments WHERE object_id IN (${placeholders}) ORDER BY created_at ASC`)
    .bind(...objectIds)
    .all<Row>();
  const map = new Map<string, LocalAttachment[]>();
  for (const r of rows.results) {
    const att = rowToAttachment(r);
    const list = map.get(att.objectId) ?? [];
    list.push(att);
    map.set(att.objectId, list);
  }
  return map;
}

/** Export rowToActor for use in route handlers that read raw DB rows */
export { rowToActor };

// ─────────────────────────────────────────
// Actor Fields (profile key/value pairs)
// ─────────────────────────────────────────

export async function getActorFields(db: D1Database, actorId: string): Promise<ActorField[]> {
  const rows = await db
    .prepare("SELECT * FROM actor_fields WHERE actor_id = ? ORDER BY position ASC")
    .bind(actorId)
    .all<Row>();
  return rows.results.map(rowToField);
}

export async function setActorFields(
  db: D1Database,
  actorId: string,
  fields: { name: string; value: string }[]
): Promise<void> {
  await db.prepare("DELETE FROM actor_fields WHERE actor_id = ?").bind(actorId).run();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f.name.trim()) continue;
    await db
      .prepare(
        "INSERT INTO actor_fields (id, actor_id, name, value, position) VALUES (?,?,?,?,?)"
      )
      .bind(crypto.randomUUID(), actorId, f.name.trim(), f.value.trim(), i)
      .run();
  }
}

export async function getActorStatuses_withReplies(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string
): Promise<LocalObject[]> {
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT * FROM objects WHERE actor_id = ? AND in_reply_to_id IS NOT NULL
         AND published < (SELECT published FROM objects WHERE id = ?)
         ORDER BY published DESC LIMIT ?`
      )
      .bind(actorId, maxId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(
      "SELECT * FROM objects WHERE actor_id = ? AND in_reply_to_id IS NOT NULL ORDER BY published DESC LIMIT ?"
    )
    .bind(actorId, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

// ─────────────────────────────────────────
// Blocks (user-level)
// ─────────────────────────────────────────

export async function createBlock(db: D1Database, id: string, actorId: string, targetId: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO blocks (id, actor_id, target_id) VALUES (?,?,?)")
    .bind(id, actorId, targetId)
    .run();
  // Remove any existing follows in both directions
  await db.prepare("DELETE FROM follows WHERE (actor_id = ? AND target_id = ?) OR (actor_id = ? AND target_id = ?)")
    .bind(actorId, targetId, targetId, actorId)
    .run();
}

export async function deleteBlock(db: D1Database, actorId: string, targetId: string): Promise<void> {
  await db
    .prepare("DELETE FROM blocks WHERE actor_id = ? AND target_id = ?")
    .bind(actorId, targetId)
    .run();
}

export async function isBlocked(db: D1Database, actorId: string, targetId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM blocks WHERE actor_id = ? AND target_id = ?")
    .bind(actorId, targetId)
    .first<Row>();
  return row !== null;
}

export async function getBlockedActors(
  db: D1Database,
  actorId: string,
  limit = 40,
  offset = 0
): Promise<LocalActor[]> {
  const rows = await db
    .prepare(
      `SELECT a.* FROM actors a
       JOIN blocks b ON b.target_id = a.id
       WHERE b.actor_id = ?
       ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(actorId, limit, offset)
    .all<Row>();
  return rows.results.map(rowToActor);
}

// ─────────────────────────────────────────
// Domain blocks (instance-level)
// ─────────────────────────────────────────

export async function createDomainBlock(db: D1Database, id: string, actorId: string, domain: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO domain_blocks (id, actor_id, domain) VALUES (?,?,?)")
    .bind(id, actorId, domain.toLowerCase())
    .run();
}

export async function deleteDomainBlock(db: D1Database, actorId: string, domain: string): Promise<void> {
  await db
    .prepare("DELETE FROM domain_blocks WHERE actor_id = ? AND domain = ?")
    .bind(actorId, domain.toLowerCase())
    .run();
}

export async function getDomainBlocks(db: D1Database, actorId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT domain FROM domain_blocks WHERE actor_id = ? ORDER BY created_at DESC")
    .bind(actorId)
    .all<{ domain: string }>();
  return rows.results.map((r) => r.domain);
}

// ─────────────────────────────────────────
// Polls
// ─────────────────────────────────────────

function rowToPoll(r: Row): LocalPoll {
  return {
    id: r.id,
    objectId: r.object_id,
    expiresAt: r.expires_at,
    multiple: Boolean(r.multiple),
    votesCount: r.votes_count ?? 0,
    votersCount: r.voters_count ?? 0,
    createdAt: r.created_at,
  };
}

function rowToPollOption(r: Row): LocalPollOption {
  return {
    id: r.id,
    pollId: r.poll_id,
    title: r.title,
    votesCount: r.votes_count ?? 0,
    position: r.position ?? 0,
  };
}

export async function createPoll(
  db: D1Database,
  poll: { id: string; objectId: string; expiresAt: string; multiple: boolean; options: { id: string; title: string; position: number }[] }
): Promise<void> {
  await db
    .prepare("INSERT INTO polls (id, object_id, expires_at, multiple) VALUES (?,?,?,?)")
    .bind(poll.id, poll.objectId, poll.expiresAt, poll.multiple ? 1 : 0)
    .run();
  for (const opt of poll.options) {
    await db
      .prepare("INSERT INTO poll_options (id, poll_id, title, position) VALUES (?,?,?,?)")
      .bind(opt.id, poll.id, opt.title, opt.position)
      .run();
  }
}

export async function getPollsByObjectIds(
  db: D1Database,
  objectIds: string[]
): Promise<Map<string, { poll: LocalPoll; options: LocalPollOption[] }>> {
  if (objectIds.length === 0) return new Map();
  const placeholders = objectIds.map(() => "?").join(",");
  const pollRows = await db
    .prepare(`SELECT * FROM polls WHERE object_id IN (${placeholders})`)
    .bind(...objectIds)
    .all<Row>();
  if (pollRows.results.length === 0) return new Map();
  const pollIds = pollRows.results.map((r) => r.id as string);
  const optPlaceholders = pollIds.map(() => "?").join(",");
  const optRows = await db
    .prepare(`SELECT * FROM poll_options WHERE poll_id IN (${optPlaceholders}) ORDER BY position ASC`)
    .bind(...pollIds)
    .all<Row>();
  const optsByPollId = new Map<string, LocalPollOption[]>();
  for (const r of optRows.results) {
    const opt = rowToPollOption(r);
    const list = optsByPollId.get(opt.pollId) ?? [];
    list.push(opt);
    optsByPollId.set(opt.pollId, list);
  }
  const map = new Map<string, { poll: LocalPoll; options: LocalPollOption[] }>();
  for (const r of pollRows.results) {
    const poll = rowToPoll(r);
    map.set(poll.objectId, { poll, options: optsByPollId.get(poll.id) ?? [] });
  }
  return map;
}

export async function getPollByObjectId(db: D1Database, objectId: string): Promise<LocalPoll | null> {
  const row = await db.prepare("SELECT * FROM polls WHERE object_id = ?").bind(objectId).first<Row>();
  return row ? rowToPoll(row) : null;
}

export async function getPollById(db: D1Database, id: string): Promise<LocalPoll | null> {
  const row = await db.prepare("SELECT * FROM polls WHERE id = ?").bind(id).first<Row>();
  return row ? rowToPoll(row) : null;
}

export async function getPollOptions(db: D1Database, pollId: string): Promise<LocalPollOption[]> {
  const rows = await db
    .prepare("SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position ASC")
    .bind(pollId)
    .all<Row>();
  return rows.results.map(rowToPollOption);
}

export async function getPollVotesByActor(db: D1Database, pollId: string, actorId: string): Promise<number[]> {
  const rows = await db
    .prepare("SELECT option_idx FROM poll_votes WHERE poll_id = ? AND actor_id = ?")
    .bind(pollId, actorId)
    .all<{ option_idx: number }>();
  return rows.results.map((r) => r.option_idx);
}

export async function createPollVotes(
  db: D1Database,
  pollId: string,
  actorId: string,
  choices: number[]
): Promise<void> {
  for (const choice of choices) {
    await db
      .prepare("INSERT OR IGNORE INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), pollId, actorId, choice)
      .run();
    await db
      .prepare("UPDATE poll_options SET votes_count = votes_count + 1 WHERE poll_id = ? AND position = ?")
      .bind(pollId, choice)
      .run();
  }
  await db
    .prepare("UPDATE polls SET votes_count = votes_count + ?, voters_count = voters_count + 1 WHERE id = ?")
    .bind(choices.length, pollId)
    .run();
}

// ─────────────────────────────────────────
// Email verification tokens
// ─────────────────────────────────────────

export async function createEmailVerification(
  db: D1Database,
  actorId: string,
  token: string,
  expiresAt: string
): Promise<void> {
  // Remove any existing tokens for this actor before creating a new one
  await db.prepare("DELETE FROM email_verifications WHERE actor_id = ?").bind(actorId).run();
  await db
    .prepare(
      "INSERT INTO email_verifications (id, actor_id, token, expires_at) VALUES (?,?,?,?)"
    )
    .bind(crypto.randomUUID(), actorId, token, expiresAt)
    .run();
}

export async function getEmailVerificationByToken(
  db: D1Database,
  token: string
): Promise<EmailVerification | null> {
  const row = await db
    .prepare("SELECT * FROM email_verifications WHERE token = ?")
    .bind(token)
    .first<Row>();
  if (!row) return null;
  return {
    id: row.id,
    actorId: row.actor_id,
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function deleteEmailVerification(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM email_verifications WHERE token = ?").bind(token).run();
}

export async function markEmailVerified(db: D1Database, actorId: string): Promise<void> {
  await db
    .prepare("UPDATE actors SET email_verified = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(actorId)
    .run();
}

