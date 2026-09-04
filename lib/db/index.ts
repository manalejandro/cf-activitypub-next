import type { D1Database } from "@cloudflare/workers-types";
import { sanitizeFediversePlain, sanitizeRemoteActorSummary } from "@/lib/activitypub/sanitize";
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
  LocalCustomEmoji,
  LocalMarker,
  LocalPushSubscription,
  LocalCollection,
  LocalCollectionItem,
  OAuthApp,
  OAuthToken,
  AuthorizedAppConnection,
  APActor,
  ObjectEdit,
  LocalMlsKeyPackage,
  LocalMlsMessage,
} from "@/lib/types";

// ─────────────────────────────────────────
// Row mappers — D1 returns snake_case column names; convert to camelCase
// ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Parse a JSON-array column defensively (e.g. actors.also_known_as). */
function safeJsonParseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface EmailVerification {
  id: string;
  actorId: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

export interface PasswordReset {
  id: string;
  actorId: string;
  token: string;
  expiresAt: string;
  used: boolean;
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
    role: r.role ?? undefined,
    suspended: r.suspended === undefined ? undefined : Boolean(r.suspended),
    silenced: r.silenced === undefined ? undefined : Boolean(r.silenced),
    reserved: r.reserved === undefined ? undefined : Boolean(r.reserved),
    verified: r.verified === undefined ? undefined : Boolean(r.verified),
    alsoKnownAs: r.also_known_as ? safeJsonParseArray(r.also_known_as) : null,
    movedTo: r.moved_to ?? null,
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
    verifiedAt: r.verified_at ?? null,
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
    quoteId: r.quote_id ?? null,
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

/** Check if a viewer is mentioned in a status (parses the raw AP JSON for Mention tags). */
function isMentioned(obj: Pick<LocalObject, "raw">, viewerId: string): boolean {
  try {
    const raw = JSON.parse(obj.raw);
    const tags: { type?: string; href?: string }[] = raw.tag ?? [];
    return tags.some((t) => t.type === "Mention" && t.href === viewerId);
  } catch {
    return false;
  }
}

/**
 * Check whether a viewer is allowed to see a status based on visibility rules.
 * Matches Mastodon behaviour:
 * - public / unlisted → always visible
 * - followers (private) → visible to author or followers
 * - direct → visible to author or mentioned users
 */
export function canViewStatus(
  obj: Pick<LocalObject, "visibility" | "actorId" | "raw">,
  viewerId: string | null,
  isFollowing: boolean
): boolean {
  if (viewerId === obj.actorId) return true;
  switch (obj.visibility) {
    case "public":
    case "unlisted":
      return true;
    case "followers":
      return isFollowing;
    case "direct":
      return viewerId !== null && isMentioned(obj, viewerId);
    default:
      return true;
  }
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
    sensitive: Boolean(r.sensitive),
    createdAt: r.created_at,
  };
}

// ─────────────────────────────────────────
// Actors
// ─────────────────────────────────────────

/**
 * Last public post date of an actor (YYYY-MM-DD form, like Mastodon's
 * `last_status_at`), or null when the actor has no public statuses.
 *
 * Remote actors: the value federated in their AP actor document (stored in
 * actors.last_status_at) is authoritative — our `objects` table only holds the
 * subset of their statuses we have seen. Local actors: computed from their
 * own objects.
 */
export async function getLastStatusAt(db: D1Database, actorId: string): Promise<string | null> {
  // Remote actors: the value federated in their AP actor document (stored in
  // actors.last_status_at) is authoritative — our `objects` table only holds
  // the subset of their statuses we have seen. Local actors: computed from
  // their own objects.
  //
  // Pre-migration fallback: if the actors.last_status_at column does not exist
  // yet (021 not applied), compute from objects for every actor so the value
  // is never null.
  let actor: { is_local: number; last_status_at: string | null } | null = null;
  try {
    actor = await db
      .prepare("SELECT is_local, last_status_at FROM actors WHERE id = ?")
      .bind(actorId)
      .first<{ is_local: number; last_status_at: string | null }>();
  } catch {
    /* column missing pre-migration — fall back to the objects computation */
  }
  if (!actor) {
    return computeLastStatusAtFromObjects(db, actorId);
  }
  if (actor.is_local !== 1) {
    return actor.last_status_at ?? computeLastStatusAtFromObjects(db, actorId);
  }
  return computeLastStatusAtFromObjects(db, actorId);
}

/** Last public post date computed from the actor's own stored objects. */
async function computeLastStatusAtFromObjects(db: D1Database, actorId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(published) AS p FROM objects WHERE actor_id = ? AND visibility IN ('public', 'unlisted') AND type IN ('Note','Article','Page','Video','Audio','Image','Document','Event','Question','Place')")
    .bind(actorId)
    .first<{ p: string | null }>();
  if (!row?.p) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.p)
    ? `${row.p.replace(" ", "T")}Z`
    : row.p;
  return iso.slice(0, 10);
}

/** Batch variant of getLastStatusAt — one grouped query for many actor ids. */
export async function getLastStatusAtMap(
  db: D1Database,
  actorIds: string[]
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const unique = [...new Set(actorIds)];
  if (unique.length === 0) return map;

  let actors: { id: string; is_local: number; last_status_at: string | null }[] | null = null;
  try {
    const placeholders = unique.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT id, is_local, last_status_at FROM actors WHERE id IN (${placeholders})`
      )
      .bind(...unique)
      .all<{ id: string; is_local: number; last_status_at: string | null }>();
    actors = rows.results ?? [];
  } catch {
    /* column missing pre-migration — compute everything from objects */
  }

  // Pre-migration: single grouped computation from objects for every actor.
  if (actors === null) {
    const lp = unique.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT actor_id, MAX(published) AS p FROM objects
         WHERE actor_id IN (${lp})
           AND visibility IN ('public', 'unlisted')
           AND type IN ('Note','Article','Page','Video','Audio','Image','Document','Event','Question','Place')
         GROUP BY actor_id`
      )
      .bind(...unique)
      .all<{ actor_id: string; p: string | null }>();
    for (const r of rows.results ?? []) {
      map.set(r.actor_id, normalizeLastStatusDate(r.p));
    }
    for (const id of unique) {
      if (!map.has(id)) map.set(id, null);
    }
    return map;
  }

  const remoteValues = new Map<string, string | null>();
  const localIds: string[] = [];
  const remoteFallbackIds: string[] = [];
  for (const a of actors) {
    if (a.is_local === 1) {
      localIds.push(a.id);
    } else if (a.last_status_at) {
      remoteValues.set(a.id, a.last_status_at);
    } else {
      // Cached before the column existed (or the remote never published the
      // date): fall back to computing from the objects we hold.
      remoteValues.set(a.id, null);
      remoteFallbackIds.push(a.id);
    }
  }

  // Grouped computation from objects for: local actors + remote actors whose
  // stored federated value is null.
  const computeIds = [...localIds, ...remoteFallbackIds];
  const computedMap = new Map<string, string | null>();
  if (computeIds.length > 0) {
    const lp = computeIds.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT actor_id, MAX(published) AS p FROM objects
         WHERE actor_id IN (${lp})
           AND visibility IN ('public', 'unlisted')
           AND type IN ('Note','Article','Page','Video','Audio','Image','Document','Event','Question','Place')
         GROUP BY actor_id`
      )
      .bind(...computeIds)
      .all<{ actor_id: string; p: string | null }>();
    for (const r of rows.results ?? []) {
      computedMap.set(r.actor_id, normalizeLastStatusDate(r.p));
    }
    for (const id of computeIds) {
      if (!computedMap.has(id)) computedMap.set(id, null);
    }
  }

  for (const id of unique) {
    if (remoteValues.has(id)) {
      map.set(id, remoteValues.get(id) ?? computedMap.get(id) ?? null);
    } else if (computedMap.has(id)) {
      map.set(id, computedMap.get(id) ?? null);
    } else {
      map.set(id, null);
    }
  }
  return map;
}

function normalizeLastStatusDate(p: string | null): string | null {
  if (!p) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(p)
    ? `${p.replace(" ", "T")}Z`
    : p;
  return iso.slice(0, 10);
}

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

/**
 * The instance's contact account: the first (oldest) local admin or moderator
 * that is not the Guardian bot.
 */
export async function getInstanceContactActor(db: D1Database): Promise<LocalActor | null> {
  const row = await db
    .prepare(
      `SELECT * FROM actors
       WHERE is_local = 1 AND role IN ('admin', 'moderator') AND username != 'guardian'
       ORDER BY created_at ASC LIMIT 1`
    )
    .first<Row>();
  return row ? rowToActor(row) : null;
}

/**
 * Resolve an actor from any of the IRIs a remote object may reference:
 * the canonical id ("https://host/users/name"), the web profile URL
 * ("https://host/@name") or a plain "name@host" acct. Falls back to
 * matching by username+domain when the exact id is unknown.
 */
export async function getActorByUri(db: D1Database, uri: string): Promise<LocalActor | null> {
  const exact = await getActorById(db, uri);
  if (exact) return exact;

  // Plain acct form: name@host
  if (!uri.startsWith("http")) {
    const at = uri.lastIndexOf("@");
    if (at > 0 && at < uri.length - 1) {
      const username = uri.slice(0, at);
      const domain = uri.slice(at + 1);
      if (!username.includes("@") && domain.includes(".")) {
        return getActorByUsername(db, username, domain);
      }
    }
    return null;
  }

  let parsed: URL;
  try { parsed = new URL(uri); } catch { return null; }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  const username = last.startsWith("@") ? last.slice(1) : last;
  if (!username) return null;
  return getActorByUsername(db, username, parsed.hostname);
}

export async function getActorByEmail(db: D1Database, email: string): Promise<LocalActor | null> {
  const row = await db
    .prepare("SELECT * FROM actors WHERE email = ?")
    .bind(email.toLowerCase())
    .first<Row>();
  return row ? rowToActor(row) : null;
}

export async function createActor(db: D1Database, actor: Omit<LocalActor, "createdAt" | "updatedAt">): Promise<void> {
  // Derive inbox URL for local actors: https://<domain>/users/<username>/inbox
  const inbox = actor.inbox ?? (actor.isLocal
    ? `https://${actor.domain.toLowerCase()}/users/${actor.username.toLowerCase()}/inbox`
    : null);
  await db
    .prepare(
      `INSERT INTO actors (
        id, username, domain, display_name, summary, avatar_url, header_url,
        public_key_pem, private_key_pem, is_local, is_bot,
        manually_approves_followers, discoverable,
        followers_count, following_count, statuses_count,
        email, password_hash, email_verified, inbox
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      actor.emailVerified ? 1 : 0,
      inbox
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
  const displayName = sanitizeFediversePlain(actor.name ?? null);
  const summary = sanitizeRemoteActorSummary(actor.summary ?? null);
  const alsoKnownAs = actor.alsoKnownAs?.length ? JSON.stringify(actor.alsoKnownAs) : null;
  // Mastodon publishes the account's last activity date in the actor document;
  // use it verbatim instead of computing from the (subset of) statuses we saw.
  const lastStatusAt = (actor as unknown as Record<string, unknown>).last_status_at;
  const lastStatusAtStr = typeof lastStatusAt === "string" && lastStatusAt ? lastStatusAt.slice(0, 10) : null;
  try {
    try {
      await db
        .prepare(
          `INSERT INTO actors (
            id, username, domain, display_name, summary, avatar_url, header_url,
            public_key_pem, private_key_pem, is_local, is_bot,
            manually_approves_followers, discoverable,
            followers_count, following_count, statuses_count, inbox, also_known_as, last_status_at
          ) VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?,?,0,0,0,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name,
            summary = CASE WHEN excluded.summary IS NOT NULL THEN excluded.summary ELSE actors.summary END,
            avatar_url = CASE WHEN excluded.avatar_url IS NOT NULL THEN excluded.avatar_url ELSE actors.avatar_url END,
            header_url = CASE WHEN excluded.header_url IS NOT NULL THEN excluded.header_url ELSE actors.header_url END,
            public_key_pem = excluded.public_key_pem,
            is_bot = excluded.is_bot,
            manually_approves_followers = excluded.manually_approves_followers,
            discoverable = excluded.discoverable,
            inbox = excluded.inbox,
            also_known_as = excluded.also_known_as,
            last_status_at = excluded.last_status_at,
            updated_at = datetime('now')`
        )
        .bind(
          actor.id,
          username,
          domain,
          displayName,
          summary,
          actor.icon?.url ?? null,
          actor.image?.url ?? null,
          actor.publicKey.publicKeyPem,
          actor.type === "Service" ? 1 : 0,
          actor.manuallyApprovesFollowers ? 1 : 0,
          actor.discoverable !== false ? 1 : 0,
          actor.inbox,
          alsoKnownAs,
          lastStatusAtStr
        )
        .run();
    } catch {
      // Pre-migration (021 not applied): actors.last_status_at does not exist.
      // Retry with the legacy statement so remote actors are still cached.
      await db
        .prepare(
          `INSERT INTO actors (
            id, username, domain, display_name, summary, avatar_url, header_url,
            public_key_pem, private_key_pem, is_local, is_bot,
            manually_approves_followers, discoverable,
            followers_count, following_count, statuses_count, inbox, also_known_as
          ) VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?,?,0,0,0,?,?)
          ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name,
            summary = CASE WHEN excluded.summary IS NOT NULL THEN excluded.summary ELSE actors.summary END,
            avatar_url = CASE WHEN excluded.avatar_url IS NOT NULL THEN excluded.avatar_url ELSE actors.avatar_url END,
            header_url = CASE WHEN excluded.header_url IS NOT NULL THEN excluded.header_url ELSE actors.header_url END,
            public_key_pem = excluded.public_key_pem,
            is_bot = excluded.is_bot,
            manually_approves_followers = excluded.manually_approves_followers,
            discoverable = excluded.discoverable,
            inbox = excluded.inbox,
            also_known_as = excluded.also_known_as,
            updated_at = datetime('now')`
        )
        .bind(
          actor.id,
          username,
          domain,
          displayName,
          summary,
          actor.icon?.url ?? null,
          actor.image?.url ?? null,
          actor.publicKey.publicKeyPem,
          actor.type === "Service" ? 1 : 0,
          actor.manuallyApprovesFollowers ? 1 : 0,
          actor.discoverable !== false ? 1 : 0,
          actor.inbox,
          alsoKnownAs
        )
        .run();
    }
  } catch {
    // UNIQUE(username, domain) conflict — actor may have migrated to a new URL.
    // Update the existing row's id so getActorById(actor.id) works after this call.
    try {
      await db
        .prepare(
          `UPDATE actors SET
            id = ?, display_name = ?, summary = ?, avatar_url = ?, header_url = ?,
            public_key_pem = ?, is_bot = ?, manually_approves_followers = ?,
            discoverable = ?, inbox = ?, also_known_as = ?, updated_at = datetime('now')
          WHERE username = ? AND domain = ?`
        )
        .bind(
          actor.id,
          displayName,
          summary,
          actor.icon?.url ?? null,
          actor.image?.url ?? null,
          actor.publicKey.publicKeyPem,
          actor.type === "Service" ? 1 : 0,
          actor.manuallyApprovesFollowers ? 1 : 0,
          actor.discoverable !== false ? 1 : 0,
          actor.inbox,
          alsoKnownAs,
          username,
          domain
        )
        .run();
    } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────
// Bookmarks
// ─────────────────────────────────────────

export async function getBookmark(
  db: D1Database,
  actorId: string,
  objectId: string
): Promise<{ id: string } | null> {
  const row = await db
    .prepare("SELECT id FROM bookmarks WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .first<{ id: string }>();
  return row ?? null;
}

/** Batch: which of the given objects the actor has bookmarked. */
export async function getBookmarkedObjectIds(
  db: D1Database,
  actorId: string,
  objectIds: string[]
): Promise<Set<string>> {
  if (objectIds.length === 0) return new Set();
  const placeholders = objectIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT object_id FROM bookmarks WHERE actor_id = ? AND object_id IN (${placeholders})`)
    .bind(actorId, ...objectIds)
    .all<{ object_id: string }>();
  return new Set(rows.results.map((r) => r.object_id));
}

export async function getBookmarkedStatusIds(
  db: D1Database,
  actorId: string
): Promise<string[]> {
  const rows = await db
    .prepare("SELECT object_id FROM bookmarks WHERE actor_id = ? ORDER BY created_at DESC")
    .bind(actorId)
    .all<{ object_id: string }>();
  return rows.results.map((r) => r.object_id);
}

export async function createBookmark(
  db: D1Database,
  id: string,
  actorId: string,
  objectId: string
): Promise<void> {
  await db
    .prepare("INSERT INTO bookmarks (id, actor_id, object_id) VALUES (?, ?, ?)")
    .bind(id, actorId, objectId)
    .run();
}

export async function deleteBookmark(
  db: D1Database,
  actorId: string,
  objectId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM bookmarks WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .run();
}

// ─────────────────────────────────────────
// Mutes
// ─────────────────────────────────────────

export async function createMute(
  db: D1Database,
  id: string,
  actorId: string,
  targetId: string,
  notifications: boolean,
  duration: number
): Promise<void> {
  await db
    .prepare("INSERT INTO mutes (id, actor_id, target_id, notifications, duration) VALUES (?, ?, ?, ?, ?)")
    .bind(id, actorId, targetId, notifications ? 1 : 0, duration)
    .run();
}

export async function deleteMute(
  db: D1Database,
  actorId: string,
  targetId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM mutes WHERE actor_id = ? AND target_id = ?")
    .bind(actorId, targetId)
    .run();
}

export async function isMuted(
  db: D1Database,
  actorId: string,
  targetId: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM mutes WHERE actor_id = ? AND target_id = ?")
    .bind(actorId, targetId)
    .first();
  return row !== null;
}

export async function getMutedActorIds(
  db: D1Database,
  actorId: string
): Promise<string[]> {
  const rows = await db
    .prepare("SELECT target_id FROM mutes WHERE actor_id = ? ORDER BY created_at DESC")
    .bind(actorId)
    .all<{ target_id: string }>();
  return rows.results.map((r) => r.target_id);
}

// ─────────────────────────────────────────
// Lists
// ─────────────────────────────────────────

export async function getLists(
  db: D1Database,
  actorId: string
): Promise<{ id: string; title: string; replies_policy: string; exclusive: boolean }[]> {
  const rows = await db
    .prepare("SELECT id, title, replies_policy, exclusive FROM lists WHERE actor_id = ? ORDER BY title ASC")
    .bind(actorId)
    .all<{ id: string; title: string; replies_policy: string; exclusive: number }>();
  return rows.results.map((r) => ({
    id: r.id,
    title: r.title,
    replies_policy: r.replies_policy,
    exclusive: Boolean(r.exclusive),
  }));
}

export async function getListById(
  db: D1Database,
  id: string
): Promise<{ id: string; actor_id: string; title: string; replies_policy: string; exclusive: boolean } | null> {
  const row = await db
    .prepare("SELECT id, actor_id, title, replies_policy, exclusive FROM lists WHERE id = ?")
    .bind(id)
    .first<{ id: string; actor_id: string; title: string; replies_policy: string; exclusive: number }>();
  if (!row) return null;
  return {
    id: row.id,
    actor_id: row.actor_id,
    title: row.title,
    replies_policy: row.replies_policy,
    exclusive: Boolean(row.exclusive),
  };
}

export async function createList(
  db: D1Database,
  id: string,
  actorId: string,
  title: string,
  repliesPolicy: string,
  exclusive: boolean
): Promise<void> {
  await db
    .prepare("INSERT INTO lists (id, actor_id, title, replies_policy, exclusive) VALUES (?, ?, ?, ?, ?)")
    .bind(id, actorId, title, repliesPolicy, exclusive ? 1 : 0)
    .run();
}

export async function updateList(
  db: D1Database,
  id: string,
  title?: string,
  repliesPolicy?: string,
  exclusive?: boolean
): Promise<void> {
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  if (title !== undefined) { sets.push("title = ?"); vals.push(title); }
  if (repliesPolicy !== undefined) { sets.push("replies_policy = ?"); vals.push(repliesPolicy); }
  if (exclusive !== undefined) { sets.push("exclusive = ?"); vals.push(exclusive ? 1 : 0); }
  if (vals.length === 0) return;
  vals.push(id);
  await db.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export async function deleteList(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM lists WHERE id = ?").bind(id).run();
}

export async function getListAccountIds(
  db: D1Database,
  listId: string
): Promise<string[]> {
  const rows = await db
    .prepare("SELECT actor_id FROM list_accounts WHERE list_id = ?")
    .bind(listId)
    .all<{ actor_id: string }>();
  return rows.results.map((r) => r.actor_id);
}

export async function addAccountsToList(
  db: D1Database,
  listId: string,
  actorIds: string[]
): Promise<void> {
  if (actorIds.length === 0) return;
  const placeholders = actorIds.map(() => "?").join(",");
  const existing = await db
    .prepare(`SELECT id FROM actors WHERE id IN (${placeholders})`)
    .bind(...actorIds)
    .all<{ id: string }>();
  const valid = new Set(existing.results.map((a) => a.id));
  for (const actorId of actorIds) {
    if (!valid.has(actorId)) continue;
    await db
      .prepare("INSERT OR IGNORE INTO list_accounts (id, list_id, actor_id) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), listId, actorId)
      .run();
  }
}

export async function removeAccountsFromList(
  db: D1Database,
  listId: string,
  actorIds: string[]
): Promise<void> {
  if (actorIds.length === 0) return;
  for (const actorId of actorIds) {
    await db
      .prepare("DELETE FROM list_accounts WHERE list_id = ? AND actor_id = ?")
      .bind(listId, actorId)
      .run();
  }
}

// ─────────────────────────────────────────
// Collections
// ─────────────────────────────────────────

/** A collections table row augmented with its item count. */
export interface CollectionRow {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  language: string | null;
  tag_name: string | null;
  sensitive: number;
  discoverable: number;
  local: number;
  created_at: string;
  updated_at: string;
  item_count: number;
}

function rowToCollection(r: Row): CollectionRow {
  return {
    id: r.id,
    account_id: r.account_id,
    name: r.name,
    description: r.description ?? null,
    language: r.language ?? null,
    tag_name: r.tag_name ?? null,
    sensitive: r.sensitive,
    discoverable: r.discoverable,
    local: r.local,
    created_at: r.created_at,
    updated_at: r.updated_at,
    item_count: r.item_count ?? 0,
  };
}

const COLLECTION_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count FROM collections c`;

export async function createCollection(db: D1Database, col: LocalCollection): Promise<void> {
  await db
    .prepare(
      `INSERT INTO collections (id, account_id, name, description, language, tag_name, sensitive, discoverable, local, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      col.id,
      col.accountId,
      col.name,
      col.description ?? null,
      col.language ?? null,
      col.tagName ?? null,
      col.sensitive ? 1 : 0,
      col.discoverable ? 1 : 0,
      col.local ? 1 : 0,
      col.createdAt,
      col.updatedAt
    )
    .run();
}

export async function getCollectionById(db: D1Database, id: string): Promise<CollectionRow | null> {
  const row = await db
    .prepare(`${COLLECTION_SELECT} WHERE c.id = ?`)
    .bind(id)
    .first<Row>();
  return row ? rowToCollection(row) : null;
}

export async function listCollectionsForAccount(
  db: D1Database,
  accountId: string,
  opts: { discoverableOnly?: boolean; limit?: number; offset?: number } = {}
): Promise<CollectionRow[]> {
  const { discoverableOnly = false, limit = 40, offset = 0 } = opts;
  const where = discoverableOnly ? "WHERE c.account_id = ? AND c.discoverable = 1" : "WHERE c.account_id = ?";
  const rows = await db
    .prepare(`${COLLECTION_SELECT} ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`)
    .bind(accountId, limit, offset)
    .all<Row>();
  return (rows.results ?? []).map(rowToCollection);
}

export async function listCollectionsFeaturedIn(
  db: D1Database,
  accountId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<CollectionRow[]> {
  const { limit = 40, offset = 0 } = opts;
  const rows = await db
    .prepare(
      `${COLLECTION_SELECT} JOIN collection_items ci ON ci.collection_id = c.id
       WHERE ci.account_id = ? AND ci.state = 'accepted'
       GROUP BY c.id
       ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(accountId, limit, offset)
    .all<Row>();
  return (rows.results ?? []).map(rowToCollection);
}

export async function searchCollections(
  db: D1Database,
  query: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<CollectionRow[]> {
  const { limit = 40, offset = 0 } = opts;
  const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
  const tagLike = `%${query.replace(/^#/, "").replace(/[%_]/g, "\\$&")}%`;
  const rows = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
       FROM collections c
       JOIN actors a ON a.id = c.account_id
       WHERE c.discoverable = 1 AND a.suspended = 0 AND a.silenced = 0
         AND (c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\' OR c.tag_name LIKE ? ESCAPE '\\')
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(like, like, tagLike, limit, offset)
    .all<Row>();
  return (rows.results ?? []).map(rowToCollection);
}

export async function updateCollection(
  db: D1Database,
  id: string,
  fields: {
    name?: string;
    description?: string | null;
    language?: string | null;
    tagName?: string | null;
    sensitive?: boolean;
    discoverable?: boolean;
  }
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [new Date().toISOString()];
  if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
  if (fields.description !== undefined) { sets.push("description = ?"); vals.push(fields.description); }
  if (fields.language !== undefined) { sets.push("language = ?"); vals.push(fields.language); }
  if (fields.tagName !== undefined) { sets.push("tag_name = ?"); vals.push(fields.tagName); }
  if (fields.sensitive !== undefined) { sets.push("sensitive = ?"); vals.push(fields.sensitive ? 1 : 0); }
  if (fields.discoverable !== undefined) { sets.push("discoverable = ?"); vals.push(fields.discoverable ? 1 : 0); }
  if (vals.length === 1) return;
  vals.push(id);
  await db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export async function deleteCollection(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM collections WHERE id = ?").bind(id).run();
}

export async function getCollectionItems(db: D1Database, collectionId: string): Promise<LocalCollectionItem[]> {
  const rows = await db
    .prepare("SELECT id, collection_id, account_id, state, created_at FROM collection_items WHERE collection_id = ? ORDER BY created_at ASC")
    .bind(collectionId)
    .all<{ id: string; collection_id: string; account_id: string; state: string; created_at: string }>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    collectionId: r.collection_id,
    accountId: r.account_id,
    state: r.state === "pending" ? "pending" : "accepted",
    createdAt: r.created_at,
  }));
}

export async function getCollectionAccountIds(db: D1Database, collectionId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT account_id FROM collection_items WHERE collection_id = ?")
    .bind(collectionId)
    .all<{ account_id: string }>();
  return (rows.results ?? []).map((r) => r.account_id);
}

export async function getCollectionItemByAccount(
  db: D1Database,
  collectionId: string,
  accountId: string
): Promise<LocalCollectionItem | null> {
  const row = await db
    .prepare("SELECT id, collection_id, account_id, state, created_at FROM collection_items WHERE collection_id = ? AND account_id = ?")
    .bind(collectionId, accountId)
    .first<{ id: string; collection_id: string; account_id: string; state: string; created_at: string }>();
  if (!row) return null;
  return {
    id: row.id,
    collectionId: row.collection_id,
    accountId: row.account_id,
    state: row.state === "pending" ? "pending" : "accepted",
    createdAt: row.created_at,
  };
}

export async function getCollectionItemById(
  db: D1Database,
  id: string
): Promise<LocalCollectionItem | null> {
  const row = await db
    .prepare("SELECT id, collection_id, account_id, state, created_at FROM collection_items WHERE id = ?")
    .bind(id)
    .first<{ id: string; collection_id: string; account_id: string; state: string; created_at: string }>();
  if (!row) return null;
  return {
    id: row.id,
    collectionId: row.collection_id,
    accountId: row.account_id,
    state: row.state === "pending" ? "pending" : "accepted",
    createdAt: row.created_at,
  };
}

export async function addAccountToCollection(
  db: D1Database,
  collectionId: string,
  accountId: string
): Promise<LocalCollectionItem | null> {
  const actor = await getActorById(db, accountId);
  if (!actor) return null;
  const existing = await getCollectionItemByAccount(db, collectionId, accountId);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .prepare("INSERT INTO collection_items (id, collection_id, account_id, state, created_at) VALUES (?, ?, ?, 'accepted', ?)")
    .bind(id, collectionId, accountId, createdAt)
    .run();
  return { id, collectionId, accountId, state: "accepted" as const, createdAt };
}

export async function removeAccountFromCollection(
  db: D1Database,
  collectionId: string,
  accountId: string
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM collection_items WHERE collection_id = ? AND account_id = ?")
    .bind(collectionId, accountId)
    .run();
  return result.meta.changes > 0;
}

export async function deleteCollectionItem(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM collection_items WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

// ─────────────────────────────────────────
// Conversations
// ─────────────────────────────────────────

export async function getConversations(
  db: D1Database,
  actorId: string,
  limit: number
): Promise<{ id: string; last_status_id: string | null; unread: boolean; updated_at: string }[]> {
  const rows = await db
    .prepare("SELECT id, last_status_id, unread, updated_at FROM conversations WHERE actor_id = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(actorId, limit)
    .all<{ id: string; last_status_id: string | null; unread: number; updated_at: string }>();
  return rows.results.map((r) => ({
    id: r.id,
    last_status_id: r.last_status_id,
    unread: Boolean(r.unread),
    updated_at: r.updated_at,
  }));
}

export async function getConversationById(
  db: D1Database,
  id: string
): Promise<{ id: string; actor_id: string; last_status_id: string | null; unread: boolean } | null> {
  const row = await db
    .prepare("SELECT id, actor_id, last_status_id, unread FROM conversations WHERE id = ?")
    .bind(id)
    .first<{ id: string; actor_id: string; last_status_id: string | null; unread: number }>();
  if (!row) return null;
  return { id: row.id, actor_id: row.actor_id, last_status_id: row.last_status_id, unread: Boolean(row.unread) };
}

export async function deleteConversation(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM conversations WHERE id = ?").bind(id).run();
}

export async function markConversationRead(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE conversations SET unread = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
}

/**
 * Upsert a direct-message conversation row for one local participant. The
 * conversation id is derived from the owning actor and the sorted "other"
 * participants so it is stable across messages in the same thread. unread
 * marks whether the owner has not yet seen the latest message.
 */
export async function upsertDirectConversation(
  db: D1Database,
  ownerActorId: string,
  otherActorIds: string[],
  lastStatusId: string,
  unread: boolean
): Promise<void> {
  const others = [...new Set(otherActorIds)].filter((id) => id && id !== ownerActorId).sort();
  if (others.length === 0) return;
  // Normalise alternate IRI spellings of the same remote actor
  // (https://host/@user vs https://host/users/user) so the outgoing and
  // incoming sides of a thread share one conversation id.
  const canonical: string[] = [];
  for (const oid of others) {
    const actor = await getActorByUri(db, oid);
    canonical.push(actor ? actor.id : oid);
  }
  const key = [...new Set(canonical)].sort().join("+");
  const id = `dm:${ownerActorId}::${key}`;
  await db
    .prepare(
      `INSERT INTO conversations (id, actor_id, last_status_id, unread, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         last_status_id = excluded.last_status_id,
         unread = excluded.unread,
         updated_at = datetime('now')`
    )
    .bind(id, ownerActorId, lastStatusId, unread ? 1 : 0)
    .run();
}

// ─────────────────────────────────────────
// Filters v2
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// Scheduled statuses
// ─────────────────────────────────────────

export async function getScheduledStatuses(
  db: D1Database,
  actorId: string,
  limit: number
): Promise<{ id: string; scheduled_at: string; params: string; media_ids: string | null }[]> {
  const rows = await db
    .prepare("SELECT id, scheduled_at, params, media_ids FROM scheduled_statuses WHERE actor_id = ? ORDER BY scheduled_at ASC LIMIT ?")
    .bind(actorId, limit)
    .all<{ id: string; scheduled_at: string; params: string; media_ids: string | null }>();
  return rows.results;
}

export async function getScheduledStatusById(db: D1Database, id: string): Promise<{ id: string; actor_id: string; scheduled_at: string; params: string; media_ids: string | null } | null> {
  const row = await db
    .prepare("SELECT id, actor_id, scheduled_at, params, media_ids FROM scheduled_statuses WHERE id = ?")
    .bind(id)
    .first<{ id: string; actor_id: string; scheduled_at: string; params: string; media_ids: string | null }>();
  return row ?? null;
}

export async function createScheduledStatus(db: D1Database, id: string, actorId: string, scheduledAt: string, params: string, mediaIds: string | null): Promise<void> {
  await db
    .prepare("INSERT INTO scheduled_statuses (id, actor_id, scheduled_at, params, media_ids) VALUES (?, ?, ?, ?, ?)")
    .bind(id, actorId, scheduledAt, params, mediaIds)
    .run();
}

export async function updateScheduledStatus(db: D1Database, id: string, scheduledAt: string): Promise<void> {
  await db
    .prepare("UPDATE scheduled_statuses SET scheduled_at = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(scheduledAt, id)
    .run();
}

export async function deleteScheduledStatus(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM scheduled_statuses WHERE id = ?").bind(id).run();
}

// ─────────────────────────────────────────
// Reports
// ─────────────────────────────────────────

export async function createReport(
  db: D1Database,
  id: string,
  actorId: string,
  targetId: string,
  statusIds: string | null,
  comment: string,
  category: string,
  ruleIds: string | null,
  forwarded: boolean
): Promise<void> {
  await db
    .prepare("INSERT INTO reports (id, actor_id, target_id, status_ids, comment, category, rule_ids, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, actorId, targetId, statusIds, comment, category, ruleIds, forwarded ? 1 : 0)
    .run();
}

export async function getReportById(db: D1Database, id: string): Promise<{ id: string; actor_id: string; target_id: string; status_ids: string | null; comment: string; category: string; rule_ids: string | null; forwarded: boolean; action_taken: boolean; created_at: string } | null> {
  const row = await db
    .prepare("SELECT id, actor_id, target_id, status_ids, comment, category, rule_ids, forwarded, action_taken, created_at FROM reports WHERE id = ?")
    .bind(id)
    .first<{ id: string; actor_id: string; target_id: string; status_ids: string | null; comment: string; category: string; rule_ids: string | null; forwarded: number; action_taken: number; created_at: string }>();
  if (!row) return null;
  return { ...row, forwarded: Boolean(row.forwarded), action_taken: Boolean(row.action_taken) };
}

export async function getReportsByActor(db: D1Database, actorId: string): Promise<{
  id: string; actor_id: string; target_id: string; status_ids: string | null;
  comment: string; category: string; rule_ids: string | null;
  forwarded: boolean; action_taken: boolean; created_at: string
}[]> {
  const rows = await db
    .prepare("SELECT id, actor_id, target_id, status_ids, comment, category, rule_ids, forwarded, action_taken, created_at FROM reports WHERE actor_id = ? ORDER BY created_at DESC")
    .bind(actorId)
    .all<{ id: string; actor_id: string; target_id: string; status_ids: string | null; comment: string; category: string; rule_ids: string | null; forwarded: number; action_taken: number; created_at: string }>();
  return rows.results.map((r) => ({ ...r, forwarded: Boolean(r.forwarded), action_taken: Boolean(r.action_taken) }));
}

// ─────────────────────────────────────────
// Report notes (moderation discussion on a report)
// ─────────────────────────────────────────

export async function createReportNote(db: D1Database, id: string, reportId: string, actorId: string, content: string): Promise<void> {
  await db
    .prepare("INSERT INTO report_notes (id, report_id, actor_id, content) VALUES (?, ?, ?, ?)")
    .bind(id, reportId, actorId, content)
    .run();
}

export async function getReportNotes(db: D1Database, reportId: string): Promise<{ id: string; report_id: string; actor_id: string; content: string; created_at: string }[]> {
  const rows = await db
    .prepare("SELECT id, report_id, actor_id, content, created_at FROM report_notes WHERE report_id = ? ORDER BY created_at ASC")
    .bind(reportId)
    .all<{ id: string; report_id: string; actor_id: string; content: string; created_at: string }>();
  return rows.results;
}

// ─────────────────────────────────────────
// Featured tags
// ─────────────────────────────────────────

export async function getFeaturedTags(db: D1Database, actorId: string): Promise<{ id: string; tag_name: string; created_at: string }[]> {
  const rows = await db
    .prepare("SELECT id, tag_name, created_at FROM featured_tags WHERE actor_id = ? ORDER BY created_at DESC")
    .bind(actorId)
    .all<{ id: string; tag_name: string; created_at: string }>();
  return rows.results;
}

export async function createFeaturedTag(db: D1Database, id: string, actorId: string, tagName: string): Promise<void> {
  await db
    .prepare("INSERT INTO featured_tags (id, actor_id, tag_name) VALUES (?, ?, ?)")
    .bind(id, actorId, tagName)
    .run();
}

export async function deleteFeaturedTag(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM featured_tags WHERE id = ?").bind(id).run();
}

export async function getFeaturedTagById(db: D1Database, id: string): Promise<{ id: string; actor_id: string; tag_name: string } | null> {
  const row = await db
    .prepare("SELECT id, actor_id, tag_name FROM featured_tags WHERE id = ?")
    .bind(id)
    .first<{ id: string; actor_id: string; tag_name: string }>();
  return row ?? null;
}

export async function getTagSuggestions(db: D1Database, actorId: string): Promise<{ name: string; statuses_count: number }[]> {
  const rows = await db
    .prepare("SELECT raw FROM objects WHERE actor_id = ? AND raw LIKE '%\"type\":\"Hashtag\"%' ORDER BY published DESC LIMIT 200")
    .bind(actorId)
    .all<{ raw: string }>();

  const featuredNames = new Set(
    (await getFeaturedTags(db, actorId)).map((t) => t.tag_name)
  );

  const tagCounts = new Map<string, number>();
  for (const row of rows.results) {
    try {
      const parsed = JSON.parse(row.raw) as { tag?: { type?: string; name?: string }[] };
      const tags = parsed.tag ?? [];
      for (const tag of tags) {
        if (tag.type === "Hashtag" && tag.name) {
          const name = tag.name.replace(/^#/, "").toLowerCase();
          if (name && !featuredNames.has(name)) {
            tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
          }
        }
      }
    } catch {
      // skip malformed raw JSON
    }
  }

  return Array.from(tagCounts.entries())
    .map(([name, count]) => ({ name, statuses_count: count }))
    .sort((a, b) => b.statuses_count - a.statuses_count)
    .slice(0, 10);
}

export async function updateActor(
  db: D1Database,
  id: string,
  fields: Partial<LocalActor>
): Promise<void> {
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
    alsoKnownAs: "also_known_as",
    movedTo: "moved_to",
  };

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [jsKey, sqlKey] of Object.entries(map)) {
    if (jsKey in fields) {
      setClauses.push(`${sqlKey} = ?`);
      const v = (fields as Record<string, unknown>)[jsKey];
      // JSON columns (arrays) are stored as TEXT; D1 binds arrays directly but
      // stringifying keeps the round-trip through rowToActor consistent. D1
      // rejects `undefined`, so normalize it to NULL like the other writers.
      values.push(Array.isArray(v) ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null));
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

/**
 * Resolve the account id of the status this object replies to (the parent's
 * author), or null when it is not a reply / the parent is unknown.
 */
export async function getReplyToAccountId(db: D1Database, obj: { inReplyToId: string | null; local: boolean }): Promise<string | null> {
  if (!obj.inReplyToId) return null;
  const parent = await db.prepare("SELECT actor_id FROM objects WHERE id = ?").bind(obj.inReplyToId).first<{ actor_id: string }>();
  return parent?.actor_id ?? null;
}

/**
 * Batch variant of getReplyToAccountId. Maps object id → parent author account
 * id (null when not a reply or parent unknown).
 */
export async function getReplyToAccountIdMap(
  db: D1Database,
  objects: { id: string; inReplyToId: string | null }[]
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const parentIds = [...new Set(objects.map((o) => o.inReplyToId).filter((v): v is string => !!v))];
  if (parentIds.length === 0) {
    for (const o of objects) result.set(o.id, null);
    return result;
  }
  const parentActors = new Map<string, string>();
  for (const pid of parentIds) {
    const parent = await db.prepare("SELECT actor_id FROM objects WHERE id = ?").bind(pid).first<{ actor_id: string }>();
    if (parent) parentActors.set(pid, parent.actor_id);
  }
  for (const o of objects) {
    result.set(o.id, o.inReplyToId ? (parentActors.get(o.inReplyToId) ?? null) : null);
  }
  return result;
}

export async function createObject(db: D1Database, obj: Omit<LocalObject, "updatedAt">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (
        id, type, actor_id, content, content_warning, sensitive,
        visibility, in_reply_to_id, quote_id, language, url,
        replies_count, reblogs_count, favourites_count,
        published, is_local, raw, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      obj.quoteId ?? null,
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

/**
 * Statuses that quote the given object (accepted quotes), newest first.
 */
export async function getObjectsQuoting(
  db: D1Database,
  objectId: string,
  viewerId?: string | null,
  limit = 20,
  maxId?: string
): Promise<LocalObject[]> {
  let where = "o.quote_id = ?";
  const params: unknown[] = [objectId];
  if (maxId) {
    where += " AND o.published < ?";
    params.push(maxId);
  }
  const stateFilter = "AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = o.actor_id AND (a.silenced = 1 OR a.suspended = 1))";
  const blockFilter = viewerId
    ? "AND o.actor_id NOT IN (SELECT target_id FROM blocks WHERE actor_id = ?)"
    : "";
  if (viewerId) params.push(viewerId);
  const rows = await db
    .prepare(
      `SELECT o.* FROM objects o
       WHERE ${where} ${stateFilter} ${blockFilter}
       ORDER BY o.published DESC LIMIT ?`
    )
    .bind(...params, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

/** Count of accepted quotes on an object. */
export async function getObjectQuotesCount(db: D1Database, objectId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM objects WHERE quote_id = ?")
    .bind(objectId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/** Batch quotes count for a set of objects. */
export async function getObjectQuotesCounts(
  db: D1Database,
  objectIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (objectIds.length === 0) return map;
  const placeholders = objectIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT quote_id, COUNT(*) AS c FROM objects WHERE quote_id IN (${placeholders}) GROUP BY quote_id`)
    .bind(...objectIds)
    .all<{ quote_id: string; c: number }>();
  for (const r of rows.results) map.set(r.quote_id, Number(r.c));
  return map;
}

export async function getPublicTimeline(
  db: D1Database,
  limit = 20,
  maxId?: string,
  local = false,
  sinceId?: string,
  remote = false,
  onlyMedia = false,
  minId?: string,
  viewerId?: string
): Promise<LocalObject[]> {
  // local=true  → only statuses from this instance
  // local=false → all public statuses (federated timeline)
  // remote=true → only statuses from remote instances
  // only_media=true → only statuses with media attachments
  let localFilter = local ? "AND o.is_local = 1" : "";
  if (remote) localFilter = "AND o.is_local = 0";
  const mediaFilter = onlyMedia ? "AND EXISTS (SELECT 1 FROM attachments a WHERE a.object_id = o.id)" : "";
  // Silenced (limited) and suspended accounts never appear on public timelines.
  const stateFilter = "AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = o.actor_id AND (a.silenced = 1 OR a.suspended = 1))";
  // Blocked accounts and accounts from a domain-blocked instance are hidden for
  // the authenticated viewer.
  const blockFilter = viewerId
    ? `AND o.actor_id NOT IN (SELECT target_id FROM blocks WHERE actor_id = ?)
       AND NOT EXISTS (SELECT 1 FROM actors ba WHERE ba.id = o.actor_id AND ba.domain IN (SELECT domain FROM domain_blocks WHERE actor_id = ?))`
    : "";
  const blockBinds: unknown[] = viewerId ? [viewerId, viewerId] : [];
  if (sinceId || minId) {
    const pivot = sinceId ?? minId!;
    const pivotRow = await db
      .prepare("SELECT published FROM objects WHERE id = ?")
      .bind(pivot)
      .first<{ published: string }>();
    if (!pivotRow) return [];
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE o.visibility = 'public' ${localFilter} ${mediaFilter} ${stateFilter} ${blockFilter}
           AND o.published > ?
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(...blockBinds, pivotRow.published, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE o.visibility = 'public' ${localFilter} ${mediaFilter} ${stateFilter} ${blockFilter}
           AND o.published < (SELECT published FROM objects WHERE id = ?)
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(...blockBinds, maxId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(
      `SELECT o.* FROM objects o
       WHERE o.visibility = 'public' ${localFilter} ${mediaFilter} ${stateFilter} ${blockFilter}
       ORDER BY o.published DESC LIMIT ?`
    )
    .bind(...blockBinds, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

export async function getHomeTimeline(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string,
  minId?: string
): Promise<LocalObject[]> {
  // Own posts → all visibilities (except direct).
  // Posts from followed accounts → public, unlisted, followers-only.
  // Direct messages are excluded (handled through conversations).
  // Suspended accounts never appear in any timeline, including the home of
  // their followers (mirrors Mastodon). Silenced accounts still show to
  // followers, so only `suspended` is filtered here.
  // Blocked accounts and accounts from a domain-blocked instance are hidden.
  const baseWhere = `
    NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = o.actor_id AND a.suspended = 1)
    AND o.actor_id NOT IN (SELECT target_id FROM blocks WHERE actor_id = ?)
    AND NOT EXISTS (SELECT 1 FROM actors ba WHERE ba.id = o.actor_id AND ba.domain IN (SELECT domain FROM domain_blocks WHERE actor_id = ?))
    AND (
      (o.actor_id = ? AND o.visibility != 'direct')
      OR (
        o.actor_id IN (
          SELECT target_id FROM follows WHERE actor_id = ? AND state = 'accepted'
        )
        AND o.visibility IN ('public', 'unlisted', 'followers')
      )
    )
  `;
  if (minId) {
    const pivotRow = await db
      .prepare("SELECT published FROM objects WHERE id = ?")
      .bind(minId)
      .first<{ published: string }>();
    if (!pivotRow) return [];
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE ${baseWhere}
           AND o.published > ?
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(actorId, actorId, actorId, actorId, pivotRow.published, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE ${baseWhere}
           AND o.published < (SELECT published FROM objects WHERE id = ?)
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(actorId, actorId, actorId, actorId, maxId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(`SELECT o.* FROM objects o WHERE ${baseWhere} ORDER BY o.published DESC LIMIT ?`)
    .bind(actorId, actorId, actorId, actorId, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

export async function getHashtagTimeline(
  db: D1Database,
  hashtag: string,
  limit = 20,
  maxId?: string,
  sinceId?: string,
  viewerId?: string
): Promise<LocalObject[]> {
  // Search the raw AP JSON for Hashtag tag entries matching the given hashtag name.
  // LIKE is case-insensitive for ASCII in SQLite, so #test matches #Test etc.
  const likePattern = `%"name":"#${hashtag.toLowerCase()}"%`;
  // A leading-% LIKE cannot use an index; bound the scan to recent posts so a
  // rare tag doesn't force a full-table read (D1 overload under burst).
  const recencyBound = new Date(Date.now() - 90 * 86400000).toISOString();
  // Silenced (limited) and suspended accounts never appear on hashtag timelines.
  const stateFilter = "AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = o.actor_id AND (a.silenced = 1 OR a.suspended = 1))";
  // Blocked accounts and accounts from a domain-blocked instance are hidden.
  const blockFilter = viewerId
    ? `AND o.actor_id NOT IN (SELECT target_id FROM blocks WHERE actor_id = ?)
       AND NOT EXISTS (SELECT 1 FROM actors ba WHERE ba.id = o.actor_id AND ba.domain IN (SELECT domain FROM domain_blocks WHERE actor_id = ?))`
    : "";
  const blockBinds: unknown[] = viewerId ? [viewerId, viewerId] : [];
  if (sinceId) {
    // Newer-than cursor — used for live polling. Returns the newest posts newer
    // than the reference post (exclusive), newest first to match timeline order.
    // Look the pivot timestamp up explicitly: the naive `published > (SELECT …)`
    // returns nothing for the *whole* timeline when the pivot object is missing
    // (deleted/not-yet-cached) because `published > NULL` is never true.
    const pivot = await db
      .prepare("SELECT published FROM objects WHERE id = ?")
      .bind(sinceId)
      .first<{ published: string }>();
    if (!pivot) return [];
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE o.visibility IN ('public', 'unlisted')
           AND o.raw LIKE ?
           AND o.published >= ?
           AND o.published > ?
           ${stateFilter} ${blockFilter}
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(likePattern, recencyBound, pivot.published, ...blockBinds, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  if (maxId) {
    const rows = await db
      .prepare(
        `SELECT o.* FROM objects o
         WHERE o.visibility IN ('public', 'unlisted')
           AND o.raw LIKE ?
           AND o.published >= ?
           AND o.published < (SELECT published FROM objects WHERE id = ?)
           ${stateFilter} ${blockFilter}
         ORDER BY o.published DESC LIMIT ?`
      )
      .bind(likePattern, recencyBound, maxId, ...blockBinds, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(
      `SELECT o.* FROM objects o
       WHERE o.visibility IN ('public', 'unlisted')
         AND o.raw LIKE ?
         AND o.published >= ?
         ${stateFilter} ${blockFilter}
       ORDER BY o.published DESC LIMIT ?`
    )
    .bind(likePattern, recencyBound, ...blockBinds, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

export async function getActorStatuses(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string,
  viewerId?: string,
  isFollowing = false
): Promise<LocalObject[]> {
  const isAuthor = viewerId === actorId;
  const visibilities = isAuthor
    ? "'public', 'unlisted', 'followers', 'direct'"
    : isFollowing
      ? "'public', 'unlisted', 'followers'"
      : "'public', 'unlisted'";

  const query = (withPublished: boolean) => {
    const where = `WHERE actor_id = ? AND visibility IN (${visibilities})`;
    if (withPublished) {
      return `SELECT * FROM objects ${where}
              AND published < (SELECT published FROM objects WHERE id = ?)
              ORDER BY published DESC LIMIT ?`;
    }
    return `SELECT * FROM objects ${where}
            ORDER BY published DESC LIMIT ?`;
  };

  if (maxId) {
    const rows = await db
      .prepare(query(true))
      .bind(actorId, maxId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(query(false))
    .bind(actorId, limit)
    .all<Row>();
  return rows.results.map(rowToObject);
}

export async function updateObject(
  db: D1Database,
  id: string,
  fields: { content?: string; contentWarning?: string | null; sensitive?: boolean; language?: string | null; raw?: string }
): Promise<void> {
  const prev = await db.prepare("SELECT content, content_warning, sensitive, raw FROM objects WHERE id = ?").bind(id).first<Row>();
  if (prev) {
    await db
      .prepare("INSERT INTO object_edits (id, object_id, content, content_warning, sensitive, raw, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))")
      .bind(crypto.randomUUID(), id, prev.content ?? null, prev.content_warning ?? null, prev.sensitive ?? 0, prev.raw ?? "{}")
      .run();
  }

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

export async function getObjectEditHistory(db: D1Database, objectId: string): Promise<ObjectEdit[]> {
  const rows = await db
    .prepare("SELECT * FROM object_edits WHERE object_id = ? ORDER BY created_at DESC")
    .bind(objectId)
    .all<Row>();
  return rows.results.map(rowToObjectEdit);
}

function rowToObjectEdit(r: Row): ObjectEdit {
  return {
    id: r.id,
    objectId: r.object_id,
    content: r.content ?? null,
    contentWarning: r.content_warning ?? null,
    sensitive: Boolean(r.sensitive),
    raw: r.raw ?? "{}",
    createdAt: r.created_at,
  };
}

export async function deleteObject(db: D1Database, id: string): Promise<void> {
  // Tables that reference objects WITHOUT a FK must be cleaned explicitly:
  // status_pins (pins of a deleted status would otherwise count against the
  // pin limit) and custom_filter_statuses (stale filter entries). Likes,
  // announces, bookmarks, attachments and polls cascade via their FKs.
  await db.batch([
    db.prepare("DELETE FROM status_pins WHERE status_id = ?").bind(id),
    db.prepare("DELETE FROM custom_filter_statuses WHERE status_id = ?").bind(id),
    db.prepare("DELETE FROM objects WHERE id = ?").bind(id),
  ]);
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

export async function deleteFollow(db: D1Database, actorId: string, targetId: string): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM follows WHERE actor_id = ? AND target_id = ?")
    .bind(actorId, targetId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
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
  const result = await db
    .prepare("DELETE FROM likes WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .run();
  if (result.meta.changes > 0) {
    await db
      .prepare("UPDATE objects SET favourites_count = MAX(0, favourites_count - 1) WHERE id = ?")
      .bind(objectId)
      .run();
  }
}

/** Returns a Set of objectIds (from the provided list) that the given actor has liked. */
export async function getLikedObjectIds(
  db: D1Database,
  actorId: string,
  objectIds: string[]
): Promise<Set<string>> {
  if (objectIds.length === 0) return new Set();
  const placeholders = objectIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT object_id FROM likes WHERE actor_id = ? AND object_id IN (${placeholders})`)
    .bind(actorId, ...objectIds)
    .all<{ object_id: string }>();
  return new Set(rows.results.map((r) => r.object_id));
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
  const result = await db
    .prepare("DELETE FROM announces WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .run();
  if (result.meta.changes > 0) {
    await db
      .prepare("UPDATE objects SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?")
      .bind(objectId)
      .run();
  }
}

/** Returns a Set of objectIds (from the provided list) that the given actor has boosted. */
export async function getAnnouncedObjectIds(
  db: D1Database,
  actorId: string,
  objectIds: string[]
): Promise<Set<string>> {
  if (objectIds.length === 0) return new Set();
  const placeholders = objectIds.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT object_id FROM announces WHERE actor_id = ? AND object_id IN (${placeholders})`)
    .bind(actorId, ...objectIds)
    .all<{ object_id: string }>();
  return new Set(rows.results.map((r) => r.object_id));
}

// ─────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────

/** Returns IDs of local actors who have liked, boosted, or replied to the given object. Used for "update" notifications. */
export async function getLocalInteractedActorIds(db: D1Database, objectId: string): Promise<string[]> {
  const liked = await db
    .prepare("SELECT l.actor_id FROM likes l JOIN actors a ON a.id = l.actor_id WHERE l.object_id = ? AND a.is_local = 1")
    .bind(objectId)
    .all<{ actor_id: string }>();
  const boosted = await db
    .prepare("SELECT a2.actor_id FROM announces a2 JOIN actors a ON a.id = a2.actor_id WHERE a2.object_id = ? AND a.is_local = 1")
    .bind(objectId)
    .all<{ actor_id: string }>();
  const replied = await db
    .prepare("SELECT o.actor_id FROM objects o JOIN actors a ON a.id = o.actor_id WHERE o.in_reply_to_id = ? AND a.is_local = 1")
    .bind(objectId)
    .all<{ actor_id: string }>();
  const ids = new Set<string>();
  for (const r of liked.results) ids.add(r.actor_id);
  for (const r of boosted.results) ids.add(r.actor_id);
  for (const r of replied.results) ids.add(r.actor_id);
  return [...ids];
}

export async function createNotification(db: D1Database, notif: LocalNotification): Promise<void> {
  // Blocked accounts (and accounts from domain-blocked instances) cannot
  // interact with the recipient: drop their notifications entirely.
  if (await isActorBlockedBy(db, notif.targetAccountId, notif.accountId)) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO notifications (id, type, account_id, target_account_id, object_id, is_read)
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

export async function getNotificationById(
  db: D1Database,
  id: string
): Promise<LocalNotification | null> {
  const row = await db
    .prepare("SELECT * FROM notifications WHERE id = ?")
    .bind(id)
    .first<Row>();
  return row ? rowToNotification(row) : null;
}

export async function dismissNotification(
  db: D1Database,
  id: string,
  targetActorId: string
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND target_account_id = ?")
    .bind(id, targetActorId)
    .run();
  return result.meta.changes > 0;
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

export async function getOAuthAppById(db: D1Database, appId: string): Promise<OAuthApp | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_apps WHERE id = ?")
    .bind(appId)
    .first<Row>();
  return row ? rowToApp(row) : null;
}

export async function getOAuthTokenById(db: D1Database, id: string): Promise<OAuthToken | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_tokens WHERE id = ?")
    .bind(id)
    .first<Row>();
  return row ? rowToToken(row) : null;
}

export async function listOAuthTokensForActor(db: D1Database, actorId: string): Promise<AuthorizedAppConnection[]> {
  const rows = await db
    .prepare(
      `SELECT t.id, t.actor_id, t.app_id, t.scope, t.created_at, t.expires_at,
              a.name AS app_name, a.website AS app_website
       FROM oauth_tokens t
       LEFT JOIN oauth_apps a ON a.id = t.app_id
       WHERE t.actor_id = ?
       ORDER BY t.created_at DESC`
    )
    .bind(actorId)
    .all<Row>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    actorId: r.actor_id,
    appId: r.app_id ?? null,
    appName: r.app_name ?? null,
    appWebsite: r.app_website ?? null,
    scope: r.scope,
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
  }));
}

export async function deleteOAuthToken(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM oauth_tokens WHERE id = ?").bind(id).run();
}

// ─────────────────────────────────────────
// Attachments
// ─────────────────────────────────────────

export async function createAttachment(db: D1Database, att: LocalAttachment): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attachments (id, object_id, type, url, remote_url, description, blurhash, width, height, file_size, mime_type, sensitive)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
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
      att.mimeType ?? null,
      att.sensitive ? 1 : 0
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

/** Export rowToActor / rowToObject for use in route handlers that read raw DB rows */
export { rowToActor, rowToObject };

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

/** Batch variant of getActorFields — one query for many actor ids. */
export async function getActorFieldsMap(
  db: D1Database,
  actorIds: string[]
): Promise<Map<string, ActorField[]>> {
  const map = new Map<string, ActorField[]>();
  const unique = [...new Set(actorIds)];
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT * FROM actor_fields WHERE actor_id IN (${placeholders}) ORDER BY actor_id, position ASC`
    )
    .bind(...unique)
    .all<Row>();
  for (const r of rows.results ?? []) {
    const list = map.get(r.actor_id) ?? [];
    list.push(rowToField(r));
    map.set(r.actor_id, list);
  }
  for (const id of unique) {
    if (!map.has(id)) map.set(id, []);
  }
  return map;
}

export async function setActorFields(
  db: D1Database,
  actorId: string,
  fields: { name: string; value: string }[]
): Promise<void> {
  const incoming = fields
    .filter((f) => f.name.trim())
    .map((f) => ({ name: f.name.trim(), value: f.value.trim() }));

  // Only rewrite rows when the field set actually changed — otherwise a remote
  // actor re-fetch would wipe the cached verification needlessly.
  const existing = await getActorFields(db, actorId);
  const unchanged =
    existing.length === incoming.length &&
    existing.every((e, i) => e.name === incoming[i].name && e.value === incoming[i].value);
  if (unchanged) return;

  await db.prepare("DELETE FROM actor_fields WHERE actor_id = ?").bind(actorId).run();
  for (let i = 0; i < incoming.length; i++) {
    await db
      .prepare(
        "INSERT INTO actor_fields (id, actor_id, name, value, position, verified_at) VALUES (?,?,?,?,?,NULL)"
      )
      .bind(crypto.randomUUID(), actorId, incoming[i].name, incoming[i].value, i)
      .run();
  }
  // Fields changed → the cached account-level flag must be re-evaluated.
  await db.prepare("UPDATE actors SET verified = 0 WHERE id = ?").bind(actorId).run();
}

/**
 * Store the outcome of a rel="me" verification for one profile field.
 * `verifiedAt` is null when the link no longer verifies.
 */
export async function setActorFieldVerified(
  db: D1Database,
  fieldId: string,
  verifiedAt: string | null
): Promise<void> {
  await db
    .prepare("UPDATE actor_fields SET verified_at = ? WHERE id = ?")
    .bind(verifiedAt, fieldId)
    .run();
}

/**
 * Clear every cached verification for an actor (used before re-checking).
 */
export async function resetActorFieldVerifications(db: D1Database, actorId: string): Promise<void> {
  await db
    .prepare("UPDATE actor_fields SET verified_at = NULL WHERE actor_id = ?")
    .bind(actorId)
    .run();
}

export async function getActorStatuses_withReplies(
  db: D1Database,
  actorId: string,
  limit = 20,
  maxId?: string,
  viewerId?: string,
  isFollowing = false
): Promise<LocalObject[]> {
  const isAuthor = viewerId === actorId;
  const visibilities = isAuthor
    ? "'public', 'unlisted', 'followers', 'direct'"
    : isFollowing
      ? "'public', 'unlisted', 'followers'"
      : "'public', 'unlisted'";

  const query = (withPublished: boolean) => {
    const where = `WHERE actor_id = ? AND in_reply_to_id IS NOT NULL AND visibility IN (${visibilities})`;
    if (withPublished) {
      return `SELECT * FROM objects ${where}
              AND published < (SELECT published FROM objects WHERE id = ?)
              ORDER BY published DESC LIMIT ?`;
    }
    return `SELECT * FROM objects ${where}
            ORDER BY published DESC LIMIT ?`;
  };

  if (maxId) {
    const rows = await db
      .prepare(query(true))
      .bind(actorId, maxId, limit)
      .all<Row>();
    return rows.results.map(rowToObject);
  }
  const rows = await db
    .prepare(query(false))
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

/**
 * Whether `viewerId` has blocked `targetActorId` (direct block) or the whole
 * instance the target actor belongs to (domain block).
 */
export async function isActorBlockedBy(db: D1Database, viewerId: string, targetActorId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM blocks WHERE actor_id = ? AND target_id = ?
       UNION ALL
       SELECT 1 FROM actors WHERE id = ? AND domain IN (SELECT domain FROM domain_blocks WHERE actor_id = ?)
       LIMIT 1`
    )
    .bind(viewerId, targetActorId, targetActorId, viewerId)
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
// Instance-wide domain blocks (admin)
// ─────────────────────────────────────────

export interface InstanceDomainBlock {
  domain: string;
  severity: "silence" | "suspend";
  rejectMedia: boolean;
  rejectReports: boolean;
  privateComment: string | null;
  publicComment: string | null;
  obfuscate: boolean;
  createdAt: string;
}

function rowToInstanceDomainBlock(r: Row): InstanceDomainBlock {
  return {
    domain: r.domain,
    severity: r.severity === "silence" ? "silence" : "suspend",
    rejectMedia: Boolean(r.reject_media),
    rejectReports: Boolean(r.reject_reports),
    privateComment: r.private_comment ?? null,
    publicComment: r.public_comment ?? null,
    obfuscate: Boolean(r.obfuscate),
    createdAt: r.created_at,
  };
}

export async function getInstanceDomainBlocks(db: D1Database): Promise<InstanceDomainBlock[]> {
  const rows = await db
    .prepare("SELECT * FROM instance_domain_blocks ORDER BY created_at DESC")
    .all<Row>();
  return (rows.results ?? []).map(rowToInstanceDomainBlock);
}

export async function getInstanceDomainBlock(db: D1Database, domain: string): Promise<InstanceDomainBlock | null> {
  const row = await db
    .prepare("SELECT * FROM instance_domain_blocks WHERE domain = ?")
    .bind(domain.toLowerCase())
    .first<Row>();
  return row ? rowToInstanceDomainBlock(row) : null;
}

export async function createInstanceDomainBlock(
  db: D1Database,
  block: InstanceDomainBlock
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO instance_domain_blocks
         (domain, severity, reject_media, reject_reports, private_comment, public_comment, obfuscate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         severity = excluded.severity,
         reject_media = excluded.reject_media,
         reject_reports = excluded.reject_reports,
         private_comment = excluded.private_comment,
         public_comment = excluded.public_comment,
         obfuscate = excluded.obfuscate`
    )
    .bind(
      block.domain.toLowerCase(),
      block.severity,
      block.rejectMedia ? 1 : 0,
      block.rejectReports ? 1 : 0,
      block.privateComment,
      block.publicComment,
      block.obfuscate ? 1 : 0,
      block.createdAt
    )
    .run();
}

export async function deleteInstanceDomainBlock(db: D1Database, domain: string): Promise<void> {
  await db.prepare("DELETE FROM instance_domain_blocks WHERE domain = ?").bind(domain.toLowerCase()).run();
}

export async function isInstanceDomainBlocked(db: D1Database, domain: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM instance_domain_blocks WHERE domain = ?")
    .bind(domain.toLowerCase())
    .first();
  return row !== null;
}

// ─────────────────────────────────────────
// Instance settings (configurable instance content)
// ─────────────────────────────────────────

export async function getInstanceSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM instance_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** Read a single actor preference (e.g. `posting:default:quote_policy`). */
export async function getActorPreference(db: D1Database, actorId: string, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM preferences WHERE actor_id = ? AND key = ?")
    .bind(actorId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setInstanceSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
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
    const res = await db
      .prepare("INSERT OR IGNORE INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), pollId, actorId, choice)
      .run();
    // Only increment counters when the vote row was actually inserted, so a
    // duplicate vote (INSERT OR IGNORE) can't double-count.
    if ((res.meta?.changes ?? 0) > 0) {
      await db
        .prepare("UPDATE poll_options SET votes_count = votes_count + 1 WHERE poll_id = ? AND position = ?")
        .bind(pollId, choice)
        .run();
      await db
        .prepare("UPDATE polls SET votes_count = votes_count + 1, voters_count = voters_count + 1 WHERE id = ?")
        .bind(pollId)
        .run();
    }
  }
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

// ─────────────────────────────────────────
// Password reset tokens
// ─────────────────────────────────────────

export async function createPasswordReset(
  db: D1Database,
  actorId: string,
  token: string,
  expiresAt: string
): Promise<void> {
  await db
    .prepare("INSERT INTO password_resets (id, actor_id, token, expires_at) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), actorId, token, expiresAt)
    .run();
}

export async function getPasswordResetByToken(
  db: D1Database,
  token: string
): Promise<PasswordReset | null> {
  const row = await db
    .prepare("SELECT * FROM password_resets WHERE token = ? AND used = 0")
    .bind(token)
    .first<Row>();
  if (!row) return null;
  return {
    id: row.id,
    actorId: row.actor_id,
    token: row.token,
    expiresAt: row.expires_at,
    used: Boolean(row.used),
    createdAt: row.created_at,
  };
}

export async function markPasswordResetUsed(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("UPDATE password_resets SET used = 1 WHERE token = ?")
    .bind(token)
    .run();
}

export async function updatePassword(
  db: D1Database,
  actorId: string,
  passwordHash: string
): Promise<void> {
  await db
    .prepare("UPDATE actors SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(passwordHash, actorId)
    .run();
}

// ─────────────────────────────────────────
// Custom Emojis
// ─────────────────────────────────────────

function rowToCustomEmoji(r: Row): LocalCustomEmoji {
  return {
    id: r.id,
    shortcode: r.shortcode,
    url: r.url,
    staticUrl: r.static_url,
    category: r.category ?? null,
    visibleInPicker: Boolean(r.visible_in_picker),
    domain: r.domain ?? null,
    actorId: r.actor_id ?? null,
    disabled: Boolean(r.disabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getAllCustomEmojis(
  db: D1Database,
  includeDisabled = false
): Promise<LocalCustomEmoji[]> {
  const query = includeDisabled
    ? "SELECT * FROM custom_emojis ORDER BY category, shortcode ASC"
    : "SELECT * FROM custom_emojis WHERE disabled = 0 ORDER BY category, shortcode ASC";
  const rows = await db.prepare(query).all<Row>();
  return rows.results.map(rowToCustomEmoji);
}

export async function getCustomEmojiByShortcode(
  db: D1Database,
  shortcode: string,
  domain?: string
): Promise<LocalCustomEmoji | null> {
  if (domain) {
    const row = await db
      .prepare("SELECT * FROM custom_emojis WHERE shortcode = ? AND domain = ? AND disabled = 0")
      .bind(shortcode, domain)
      .first<Row>();
    return row ? rowToCustomEmoji(row) : null;
  }
  // Prefer local emoji, then any domain
  const row = await db
    .prepare("SELECT * FROM custom_emojis WHERE shortcode = ? AND disabled = 0 ORDER BY domain IS NULL DESC LIMIT 1")
    .bind(shortcode)
    .first<Row>();
  return row ? rowToCustomEmoji(row) : null;
}

export async function upsertCustomEmoji(
  db: D1Database,
  emoji: {
    id: string;
    shortcode: string;
    url: string;
    staticUrl: string;
    category?: string | null;
    visibleInPicker?: boolean;
    domain?: string | null;
    actorId?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO custom_emojis (id, shortcode, url, static_url, category, visible_in_picker, domain, actor_id)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(shortcode, domain) DO UPDATE SET
         url = excluded.url,
         static_url = excluded.static_url,
         category = excluded.category,
         visible_in_picker = excluded.visible_in_picker,
         disabled = 0,
         updated_at = datetime('now')`
    )
    .bind(
      emoji.id,
      emoji.shortcode,
      emoji.url,
      emoji.staticUrl,
      emoji.category ?? null,
      emoji.visibleInPicker !== false ? 1 : 0,
      emoji.domain ?? null,
      emoji.actorId ?? null
    )
    .run();
}

export async function deleteCustomEmoji(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM custom_emojis WHERE id = ?").bind(id).run();
}

export async function disableCustomEmoji(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE custom_emojis SET disabled = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

export async function getCustomEmojisByDomain(
  db: D1Database,
  domain: string
): Promise<LocalCustomEmoji[]> {
  const rows = await db
    .prepare("SELECT * FROM custom_emojis WHERE domain = ? AND disabled = 0 ORDER BY shortcode ASC")
    .bind(domain)
    .all<Row>();
  return rows.results.map(rowToCustomEmoji);
}

// ─────────────────────────────────────────
// Domain capabilities
// ─────────────────────────────────────────

export async function getDomainCallsSupport(db: D1Database, domain: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT supports_calls FROM domain_capabilities WHERE domain = ?")
    .bind(domain)
    .first<{ supports_calls: number }>();
  return row !== null && row.supports_calls === 1;
}

export async function setDomainCallsSupport(db: D1Database, domain: string, supportsCalls: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO domain_capabilities (domain, supports_calls, checked_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(domain) DO UPDATE SET supports_calls = excluded.supports_calls, checked_at = datetime('now')`
    )
    .bind(domain, supportsCalls ? 1 : 0)
    .run();
}

// ─────────────────────────────────────────
// Markers
// ─────────────────────────────────────────

export async function getMarkers(
  db: D1Database,
  actorId: string,
  timelines: string[]
): Promise<LocalMarker[]> {
  if (timelines.length === 0) return [];
  const placeholders = timelines.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT * FROM markers WHERE actor_id = ? AND timeline IN (${placeholders})`
    )
    .bind(actorId, ...timelines)
    .all<Row>();
  return rows.results.map((r) => ({
    id: r.id as string,
    actorId: r.actor_id as string,
    timeline: r.timeline as string,
    lastReadId: r.last_read_id as string,
    version: r.version as number,
    updatedAt: r.updated_at as string,
  }));
}

export async function upsertMarker(
  db: D1Database,
  id: string,
  actorId: string,
  timeline: string,
  lastReadId: string,
  currentVersion: number
): Promise<{ success: boolean; newVersion: number }> {
  const existing = await db
    .prepare("SELECT version FROM markers WHERE actor_id = ? AND timeline = ?")
    .bind(actorId, timeline)
    .first<{ version: number }>();

  if (existing) {
    if (existing.version !== currentVersion) {
      return { success: false, newVersion: existing.version };
    }
    await db
      .prepare(
        `UPDATE markers SET last_read_id = ?, version = version + 1, updated_at = datetime('now')
         WHERE actor_id = ? AND timeline = ?`
      )
      .bind(lastReadId, actorId, timeline)
      .run();
    return { success: true, newVersion: currentVersion + 1 };
  }

  await db
    .prepare(
      `INSERT INTO markers (id, actor_id, timeline, last_read_id, version, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))`
    )
    .bind(id, actorId, timeline, lastReadId)
    .run();
  return { success: true, newVersion: 1 };
}

// ─────────────────────────────────────────
// Push subscriptions
// ─────────────────────────────────────────

function rowToPushSub(r: Row): LocalPushSubscription {
  return {
    id: r.id as string,
    actorId: r.actor_id as string,
    endpoint: r.endpoint as string,
    p256dhKey: r.p256dh_key as string,
    authKey: r.auth_key as string,
    standard: Boolean(r.standard),
    policy: r.policy as string,
    alerts: r.alerts as string,
    serverKey: r.server_key as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function getPushSubscription(
  db: D1Database,
  actorId: string
): Promise<LocalPushSubscription | null> {
  const row = await db
    .prepare("SELECT * FROM push_subscriptions WHERE actor_id = ?")
    .bind(actorId)
    .first<Row>();
  return row ? rowToPushSub(row) : null;
}

export async function upsertPushSubscription(
  db: D1Database,
  sub: Omit<LocalPushSubscription, "createdAt" | "updatedAt">
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_subscriptions (id, actor_id, endpoint, p256dh_key, auth_key, standard, policy, alerts, server_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(actor_id) DO UPDATE SET
         endpoint = excluded.endpoint,
         p256dh_key = excluded.p256dh_key,
         auth_key = excluded.auth_key,
         standard = excluded.standard,
         policy = excluded.policy,
         alerts = excluded.alerts,
         server_key = excluded.server_key,
         updated_at = datetime('now')`
    )
    .bind(
      sub.id,
      sub.actorId,
      sub.endpoint,
      sub.p256dhKey,
      sub.authKey,
      sub.standard ? 1 : 0,
      sub.policy,
      sub.alerts,
      sub.serverKey
    )
    .run();
}

export async function updatePushSubscriptionAlerts(
  db: D1Database,
  actorId: string,
  alerts: string,
  policy?: string
): Promise<void> {
  if (policy !== undefined) {
    await db
      .prepare(
        `UPDATE push_subscriptions SET alerts = ?, policy = ?, updated_at = datetime('now')
         WHERE actor_id = ?`
      )
      .bind(alerts, policy, actorId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE push_subscriptions SET alerts = ?, updated_at = datetime('now')
         WHERE actor_id = ?`
      )
      .bind(alerts, actorId)
      .run();
  }
}

export async function deletePushSubscription(
  db: D1Database,
  actorId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM push_subscriptions WHERE actor_id = ?")
    .bind(actorId)
    .run();
}


// ─────────────────────────────────────────
// MLS (Messaging Layer Security) over ActivityPub
// ─────────────────────────────────────────

function rowToMlsKeyPackage(r: Row): LocalMlsKeyPackage {
  return {
    id: r.id,
    actorId: r.actor_id,
    objectId: r.object_id,
    ciphersuite: r.ciphersuite ?? null,
    mediaType: r.media_type ?? null,
    encoding: r.encoding ?? null,
    content: r.content ?? null,
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMlsMessage(r: Row): LocalMlsMessage {
  return {
    id: r.id,
    type: r.type,
    actorId: r.actor_id,
    recipientId: r.recipient_id,
    objectId: r.object_id ?? null,
    objectType: r.object_type ?? null,
    conversation: r.conversation ?? null,
    mediaType: r.media_type ?? null,
    encoding: r.encoding ?? null,
    content: r.content ?? null,
    raw: r.raw ?? "{}",
    published: r.published,
    local: Boolean(r.is_local),
    delivered: Boolean(r.delivered),
  };
}

/** Insert (or refresh) a cached key package for an actor. */
export async function upsertMlsKeyPackage(
  db: D1Database,
  kp: Omit<LocalMlsKeyPackage, "createdAt" | "updatedAt">
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mls_key_packages (
        id, actor_id, object_id, ciphersuite, media_type, encoding, content, is_active
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        ciphersuite = excluded.ciphersuite,
        media_type = excluded.media_type,
        encoding = excluded.encoding,
        content = excluded.content,
        is_active = excluded.is_active,
        updated_at = datetime('now')`
    )
    .bind(
      kp.id,
      kp.actorId,
      kp.objectId,
      kp.ciphersuite ?? null,
      kp.mediaType ?? null,
      kp.encoding ?? null,
      kp.content ?? null,
      kp.isActive ? 1 : 0
    )
    .run();
}

export async function getMlsKeyPackageById(
  db: D1Database,
  id: string
): Promise<LocalMlsKeyPackage | null> {
  const r = await db
    .prepare("SELECT * FROM mls_key_packages WHERE id = ?")
    .bind(id)
    .first<Row>();
  return r ? rowToMlsKeyPackage(r) : null;
}

export async function getMlsKeyPackageByObjectId(
  db: D1Database,
  objectId: string
): Promise<LocalMlsKeyPackage | null> {
  const r = await db
    .prepare("SELECT * FROM mls_key_packages WHERE object_id = ?")
    .bind(objectId)
    .first<Row>();
  return r ? rowToMlsKeyPackage(r) : null;
}

/** Active key packages of an actor (canonical source for a local keyPackages collection). */
export async function getMlsKeyPackagesByActor(
  db: D1Database,
  actorId: string,
  activeOnly = true
): Promise<LocalMlsKeyPackage[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM mls_key_packages WHERE actor_id = ?${activeOnly ? " AND is_active = 1" : ""}
       ORDER BY created_at DESC`
    )
    .bind(actorId)
    .all<Row>();
  return (rows.results ?? []).map(rowToMlsKeyPackage);
}

export async function setMlsKeyPackageActive(
  db: D1Database,
  objectId: string,
  active: boolean
): Promise<void> {
  await db
    .prepare(
      "UPDATE mls_key_packages SET is_active = ?, updated_at = datetime('now') WHERE object_id = ?"
    )
    .bind(active ? 1 : 0, objectId)
    .run();
}

export async function deleteMlsKeyPackageByObjectId(
  db: D1Database,
  objectId: string
): Promise<void> {
  await db.prepare("DELETE FROM mls_key_packages WHERE object_id = ?").bind(objectId).run();
}

export async function deleteMlsMessagesByObjectId(
  db: D1Database,
  objectId: string
): Promise<void> {
  await db.prepare("DELETE FROM mls_messages WHERE object_id = ?").bind(objectId).run();
}

/** Delete a single delivered MLS envelope for one recipient (per-recipient copy). */
export async function deleteMlsMessageForRecipient(
  db: D1Database,
  recipientId: string,
  id: string
): Promise<void> {
  await db
    .prepare("DELETE FROM mls_messages WHERE recipient_id = ? AND id = ?")
    .bind(recipientId, id)
    .run();
}

/** Delete every MLS envelope of a conversation for one recipient. */
export async function deleteMlsMessagesByConversation(
  db: D1Database,
  recipientId: string,
  conversation: string
): Promise<void> {
  await db
    .prepare("DELETE FROM mls_messages WHERE recipient_id = ? AND conversation = ?")
    .bind(recipientId, conversation)
    .run();
}

/** Insert an MLS message envelope for one recipient (deduped on activity id). */
export async function insertMlsMessage(
  db: D1Database,
  msg: Omit<LocalMlsMessage, "local" | "delivered">
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO mls_messages (
        id, type, actor_id, recipient_id, object_id, object_type, conversation,
        media_type, encoding, content, raw, published
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      msg.id,
      msg.type,
      msg.actorId,
      msg.recipientId,
      msg.objectId ?? null,
      msg.objectType ?? null,
      msg.conversation ?? null,
      msg.mediaType ?? null,
      msg.encoding ?? null,
      msg.content ?? null,
      msg.raw,
      msg.published
    )
    .run();
}

export async function getMlsMessagesByRecipient(
  db: D1Database,
  recipientId: string,
  limit = 50,
  maxId?: string,
  conversation?: string
): Promise<LocalMlsMessage[]> {
  const params: (string | number)[] = [recipientId];
  let filter = "";
  if (conversation) {
    filter += " AND conversation = ?";
    params.push(conversation);
  }
  if (maxId) {
    filter += " AND published < (SELECT published FROM mls_messages WHERE id = ? AND recipient_id = ?)";
    params.push(maxId, recipientId);
  }
  params.push(limit);
  const rows = await db
    .prepare(
      `SELECT * FROM mls_messages WHERE recipient_id = ?${filter}
       ORDER BY published DESC LIMIT ?`
    )
    .bind(...params)
    .all<Row>();
  return (rows.results ?? []).map(rowToMlsMessage);
}

export async function getMlsMessageById(
  db: D1Database,
  id: string
): Promise<LocalMlsMessage | null> {
  const r = await db
    .prepare("SELECT * FROM mls_messages WHERE id = ? LIMIT 1")
    .bind(id)
    .first<Row>();
  return r ? rowToMlsMessage(r) : null;
}

export async function countMlsMessagesByRecipient(
  db: D1Database,
  recipientId: string,
  conversation?: string
): Promise<number> {
  const params: (string | number)[] = [recipientId];
  let filter = "";
  if (conversation) {
    filter += " AND conversation = ?";
    params.push(conversation);
  }
  const r = await db
    .prepare(`SELECT COUNT(*) AS c FROM mls_messages WHERE recipient_id = ?${filter}`)
    .bind(...params)
    .first<{ c: number }>();
  return r?.c ?? 0;
}

/** Conversations (distinct group-id keys) a recipient has MLS traffic for. */
export async function getMlsConversationsByRecipient(
  db: D1Database,
  recipientId: string
): Promise<{ conversation: string; last: string }[]> {
  const rows = await db
    .prepare(
      `SELECT conversation, MAX(published) AS last FROM mls_messages
       WHERE recipient_id = ? AND conversation IS NOT NULL
       GROUP BY conversation ORDER BY last DESC`
    )
    .bind(recipientId)
    .all<Row>();
  return (rows.results ?? []).map((r) => ({ conversation: r.conversation, last: r.last }));
}

// ─────────────────────────────────────────
// Instance statistics (nodeinfo + /api/v1/instance)
// ─────────────────────────────────────────

export interface InstanceStats {
  userCount: number;
  statusCount: number;
  activeMonth: number;
  activeHalfyear: number;
  commentCount: number;
}

/**
 * The four instance-wide count queries (nodeinfo + instance endpoints) each
 * scan a large share of the objects table. Compute them once and cache the
 * result in KV for 15 minutes — the counts change slowly and no client needs
 * second-precision numbers. The covering index (is_local, published,
 * actor_id) keeps the recompute index-only.
 */
export async function getInstanceStats(
  db: D1Database,
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> }
): Promise<InstanceStats> {
  const cacheKey = "instance:stats";
  try {
    const cached = await kv.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as InstanceStats;
      if (typeof parsed.userCount === "number") return parsed;
    }
  } catch { /* fall through to recompute */ }

  const monthCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const halfyearCutoff = new Date(Date.now() - 180 * 86400000).toISOString();

  const [userRow, postRow, activeMonthRow, activeHalfyearRow, commentRow] = await Promise.all([
    db.prepare("SELECT COUNT(*) as count FROM actors WHERE is_local = 1").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM objects WHERE is_local = 1").first<{ count: number }>(),
    db.prepare(
      "SELECT COUNT(DISTINCT actor_id) as count FROM objects WHERE is_local = 1 AND published >= ?"
    ).bind(monthCutoff).first<{ count: number }>(),
    db.prepare(
      "SELECT COUNT(DISTINCT actor_id) as count FROM objects WHERE is_local = 1 AND published >= ?"
    ).bind(halfyearCutoff).first<{ count: number }>(),
    db.prepare(
      "SELECT COUNT(*) as count FROM objects WHERE is_local = 1 AND in_reply_to_id IS NOT NULL"
    ).first<{ count: number }>(),
  ]);

  const stats: InstanceStats = {
    userCount: userRow?.count ?? 0,
    statusCount: postRow?.count ?? 0,
    activeMonth: activeMonthRow?.count ?? 0,
    activeHalfyear: activeHalfyearRow?.count ?? 0,
    commentCount: commentRow?.count ?? 0,
  };

  await kv.put(cacheKey, JSON.stringify(stats), { expirationTtl: 900 }).catch(() => {});
  return stats;
}

// ─────────────────────────────────────────
// User filters (Mastodon-compatible, server-side v2)
// ─────────────────────────────────────────

export interface LocalFilterRow {
  id: string;
  accountId: string;
  title: string;
  action: "warn" | "hide" | "blur";
  context: string; // JSON array
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalFilterKeywordRow {
  id: string;
  customFilterId: string;
  keyword: string;
  wholeWord: boolean;
}

export interface LocalFilterStatusRow {
  id: string;
  customFilterId: string;
  statusId: string;
}

type FilterRow = {
  id: string;
  account_id: string;
  title: string;
  action: string;
  context: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type KeywordRow = {
  id: string;
  custom_filter_id: string;
  keyword: string;
  whole_word: number;
};

type StatusRow = {
  id: string;
  custom_filter_id: string;
  status_id: string;
};

export async function getFiltersForAccount(db: D1Database, accountId: string): Promise<LocalFilterRow[]> {
  // expires_at is stored ISO-8601; compare against an ISO "now" so the expiry
  // instant is exact (datetime('now') uses a space format and would keep a
  // filter active for up to a day past its expiry).
  const nowIso = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT * FROM custom_filters WHERE account_id = ?
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`
    )
    .bind(accountId, nowIso)
    .all<FilterRow>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    title: r.title,
    action: (["warn", "hide", "blur"].includes(r.action) ? r.action : "warn") as "warn" | "hide" | "blur",
    context: r.context,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getAllFiltersForAccount(db: D1Database, accountId: string): Promise<LocalFilterRow[]> {
  const rows = await db
    .prepare("SELECT * FROM custom_filters WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId)
    .all<FilterRow>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    title: r.title,
    action: (["warn", "hide", "blur"].includes(r.action) ? r.action : "warn") as "warn" | "hide" | "blur",
    context: r.context,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getFilterById(db: D1Database, id: string, accountId: string): Promise<LocalFilterRow | null> {
  const r = await db
    .prepare("SELECT * FROM custom_filters WHERE id = ? AND account_id = ?")
    .bind(id, accountId)
    .first<FilterRow>();
  if (!r) return null;
  return {
    id: r.id,
    accountId: r.account_id,
    title: r.title,
    action: (["warn", "hide", "blur"].includes(r.action) ? r.action : "warn") as "warn" | "hide" | "blur",
    context: r.context,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function insertFilter(
  db: D1Database,
  f: { id: string; accountId: string; title: string; action: "warn" | "hide" | "blur"; context: string; expiresAt: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO custom_filters (id, account_id, title, action, context, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(f.id, f.accountId, f.title, f.action, f.context, f.expiresAt)
    .run();
}

export async function updateFilter(
  db: D1Database,
  id: string,
  accountId: string,
  fields: { title?: string; action?: string; context?: string; expiresAt?: string | null }
): Promise<boolean> {
  const clauses: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  if (fields.title !== undefined) { clauses.push("title = ?"); values.push(fields.title); }
  if (fields.action !== undefined) { clauses.push("action = ?"); values.push(fields.action); }
  if (fields.context !== undefined) { clauses.push("context = ?"); values.push(fields.context); }
  if (fields.expiresAt !== undefined) { clauses.push("expires_at = ?"); values.push(fields.expiresAt); }
  if (values.length === 0) return true;
  values.push(id, accountId);
  const r = await db
    .prepare(`UPDATE custom_filters SET ${clauses.join(", ")} WHERE id = ? AND account_id = ?`)
    .bind(...values)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function deleteFilter(db: D1Database, id: string, accountId: string): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM custom_filters WHERE id = ? AND account_id = ?")
    .bind(id, accountId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function getFilterKeywords(db: D1Database, filterIds: string[]): Promise<LocalFilterKeywordRow[]> {
  if (filterIds.length === 0) return [];
  const placeholders = filterIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT * FROM custom_filter_keywords WHERE custom_filter_id IN (${placeholders}) ORDER BY created_at ASC`
    )
    .bind(...filterIds)
    .all<KeywordRow>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    customFilterId: r.custom_filter_id,
    keyword: r.keyword,
    wholeWord: r.whole_word === 1,
  }));
}

export async function getFilterKeywordById(db: D1Database, id: string): Promise<LocalFilterKeywordRow | null> {
  const r = await db
    .prepare("SELECT * FROM custom_filter_keywords WHERE id = ?")
    .bind(id)
    .first<KeywordRow>();
  if (!r) return null;
  return { id: r.id, customFilterId: r.custom_filter_id, keyword: r.keyword, wholeWord: r.whole_word === 1 };
}

export async function insertFilterKeyword(
  db: D1Database,
  k: { id: string; customFilterId: string; keyword: string; wholeWord: boolean }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO custom_filter_keywords (id, custom_filter_id, keyword, whole_word, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(k.id, k.customFilterId, k.keyword, k.wholeWord ? 1 : 0)
    .run();
}

export async function updateFilterKeyword(
  db: D1Database,
  id: string,
  keyword: string,
  wholeWord: boolean
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE custom_filter_keywords SET keyword = ?, whole_word = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(keyword, wholeWord ? 1 : 0, id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function deleteFilterKeyword(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM custom_filter_keywords WHERE id = ?").bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function getFilterStatuses(db: D1Database, filterIds: string[]): Promise<LocalFilterStatusRow[]> {
  if (filterIds.length === 0) return [];
  const placeholders = filterIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT * FROM custom_filter_statuses WHERE custom_filter_id IN (${placeholders}) ORDER BY created_at ASC`
    )
    .bind(...filterIds)
    .all<StatusRow>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    customFilterId: r.custom_filter_id,
    statusId: r.status_id,
  }));
}

export async function getFilterStatusById(db: D1Database, id: string): Promise<LocalFilterStatusRow | null> {
  const r = await db
    .prepare("SELECT * FROM custom_filter_statuses WHERE id = ?")
    .bind(id)
    .first<StatusRow>();
  if (!r) return null;
  return { id: r.id, customFilterId: r.custom_filter_id, statusId: r.status_id };
}

export async function insertFilterStatus(
  db: D1Database,
  s: { id: string; customFilterId: string; statusId: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO custom_filter_statuses (id, custom_filter_id, status_id, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .bind(s.id, s.customFilterId, s.statusId)
    .run();
}

export async function deleteFilterStatus(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM custom_filter_statuses WHERE id = ?").bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}
