import type { D1Database } from "@cloudflare/workers-types";
import { sanitizeFediversePlain, sanitizeRemoteActorSummary, sanitizeRemoteNoteContent } from "@/lib/activitypub/sanitize";
import { apAttachmentType } from "@/lib/activitypub/content";
import { extractQuoteId } from "@/lib/activitypub/utils";
import {
  getDomainCallsSupport,
  setDomainCallsSupport,
  setActorFields,
  getActorById,
  getObjectById,
  createObject,
  createAttachment,
  createPoll,
  getPollByObjectId,
  upsertCustomEmoji,
} from "@/lib/db";
import { validateOutboundUrl, fetchRemoteObject } from "@/lib/activitypub/federation";
import { isContentObjectType } from "@/lib/activitypub/vocab";
import type { APAttachment, APNote, LocalAttachment, LocalObject, LocalActor } from "@/lib/types";
import { generateId } from "@/lib/activitypub/utils";

export interface RemoteActorResult {
  id: string;
  inbox: string;
  domain: string;
}

const UA_PRIMARY = "CFActivityPub/1.0 (+https://cf-ap.com)";
const UA_BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";

/**
 * Fetch with an explicit federated User-Agent, retrying with a browser UA when
 * the remote server blocks non-browser clients (Friendica's anti-bot guard
 * rejects requests whose UA looks like a generic bot).
 */
async function remoteFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000
): Promise<Response | null> {
  const uas = [UA_PRIMARY, UA_BROWSER];
  let last: Response | null = null;
  for (const ua of uas) {
    try {
      const res = await fetch(url, {
        headers: { ...headers, "User-Agent": ua },
        signal: AbortSignal.timeout(timeoutMs),
      });
      last = res;
      if (res.ok) return res;
    } catch {
      /* try next UA */
    }
  }
  return last;
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
    const val = validateOutboundUrl(field);
    if (!val.valid) return 0;
    try {
      const r = await remoteFetch(field, {
        Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      }, 3000);
      if (r?.ok) {
        const col = await r.json() as Record<string, unknown>;
        if (typeof col.totalItems === "number") return col.totalItems;
      }
    } catch { /* ignore */ }
  }
  return 0;
}

/**
 * Probe a remote domain for call support by checking the Mastodon-compatible
 * /api/v2/instance (or /api/v1/instance) endpoint for a `calls` configuration.
 * Results are cached in the domain_capabilities table.
 */
async function probeDomainCallsSupport(db: D1Database, domain: string): Promise<boolean> {
  if (await getDomainCallsSupport(db, domain)) return true;

  const tryFetch = async (url: string): Promise<boolean> => {
    const val = validateOutboundUrl(url);
    if (!val.valid) return false;
    try {
      const res = await remoteFetch(url, { Accept: "application/json" }, 3000);
      if (!res?.ok) return false;
      const data = await res.json() as Record<string, unknown>;
      const config = data.configuration as Record<string, unknown> | undefined;
      return config?.calls !== undefined;
    } catch {
      return false;
    }
  };

  const supported =
    (await tryFetch(`https://${domain}/api/v2/instance`)) ||
    (await tryFetch(`https://${domain}/api/v1/instance`));

  await setDomainCallsSupport(db, domain, supported);
  return supported;
}

/** Fetch a remote ActivityPub actor profile and cache it in D1. */
export async function fetchAndCacheRemoteActor(
  db: D1Database,
  actorUrl: string,
  kv?: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> }
): Promise<RemoteActorResult | null> {
  const val = validateOutboundUrl(actorUrl);
  if (!val.valid) {
    console.warn(`[remote] Blocked actor fetch from ${actorUrl}: ${val.reason}`);
    return null;
  }
  try {
    const res = await remoteFetch(actorUrl, {
      Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    });
    if (!res?.ok) return null;
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

    const displayName = sanitizeFediversePlain((p.name as string) ?? username);
    let summary = sanitizeRemoteActorSummary((p.summary as string) ?? null);
    let iconUrl = (p.icon as Record<string, string>)?.url ?? null;
    const imageUrl = (p.image as Record<string, string>)?.url ?? null;

    // Friendica/DFRN (and a few minimal implementations) serve an AP actor
    // document without icon/summary — the profile details only exist on the
    // HTML page. Fall back to the HTML profile (h-card / OpenGraph) to fill
    // the missing avatar and description. The KV marker stores the extracted
    // avatar URL (reused on subsequent resolves, no re-fetch) or "0" when the
    // HTML yielded nothing (retried after the TTL expires). Key changed from
    // `ap:profilehtml` to unblock actors whose old marker blocked the fallback
    // while their stored avatar was NULL.
    if ((!iconUrl || !summary) && kv) {
      const marker = `ap:profilehtml2:${id}`;
      const cached = await kv.get(marker).catch(() => null);
      if (cached && cached !== "0") {
        if (!iconUrl) iconUrl = cached;
      } else {
        const fallback = await fetchProfileHtmlFallback((p.url as string) ?? id);
        if (!iconUrl && fallback.avatar) iconUrl = fallback.avatar;
        if (!summary && fallback.summary) summary = sanitizeRemoteActorSummary(fallback.summary);
        await kv.put(marker, iconUrl && fallback.avatar ? fallback.avatar : "0", {
          expirationTtl: iconUrl && fallback.avatar ? 86400 : 3600,
        }).catch(() => {});
      }
    }

    // Upsert — update if already exists (in case profile changed).
    // Falls back to UPDATE by username+domain when the actor migrated to a new URL.
    const alsoKnownAs = Array.isArray(p.alsoKnownAs) ? JSON.stringify(p.alsoKnownAs.filter((x) => typeof x === "string")) : null;
    // Mastodon publishes the account's last activity date; store it so the
    // account serializers can report the federated value.
    const lastStatusAtRaw = (p as unknown as Record<string, unknown>).last_status_at;
    const lastStatusAt = typeof lastStatusAtRaw === "string" && lastStatusAtRaw ? lastStatusAtRaw.slice(0, 10) : null;
    try {
      try {
        await db
          .prepare(
            `INSERT INTO actors
             (id, username, domain, display_name, summary, avatar_url, header_url,
              public_key_pem, private_key_pem, is_local, is_bot,
              manually_approves_followers, discoverable,
              followers_count, following_count, statuses_count, inbox, also_known_as, last_status_at)
             VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?,1,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               display_name = excluded.display_name,
               summary = CASE WHEN excluded.summary IS NOT NULL THEN excluded.summary ELSE actors.summary END,
               avatar_url = CASE WHEN excluded.avatar_url IS NOT NULL THEN excluded.avatar_url ELSE actors.avatar_url END,
               header_url = CASE WHEN excluded.header_url IS NOT NULL THEN excluded.header_url ELSE actors.header_url END,
               public_key_pem = excluded.public_key_pem,
               manually_approves_followers = excluded.manually_approves_followers,
               discoverable = excluded.discoverable,
               followers_count = CASE WHEN excluded.followers_count > 0 THEN excluded.followers_count ELSE actors.followers_count END,
               following_count = CASE WHEN excluded.following_count > 0 THEN excluded.following_count ELSE actors.following_count END,
               statuses_count = CASE WHEN excluded.statuses_count > 0 THEN excluded.statuses_count ELSE actors.statuses_count END,
               inbox = excluded.inbox,
               also_known_as = excluded.also_known_as,
               last_status_at = excluded.last_status_at,
               updated_at = datetime('now')`
          )
          .bind(
            id, usernameNorm, domain,
            displayName,
            summary,
            iconUrl,
            imageUrl,
            pubKey,
            (p.type as string) === "Service" ? 1 : 0,
            (p.manuallyApprovesFollowers as boolean) ? 1 : 0,
            followersCount,
            followingCount,
            statusesCount,
            inbox,
            alsoKnownAs,
            lastStatusAt,
          )
          .run();
      } catch {
        // Pre-migration (021 not applied): actors.last_status_at does not exist
        // yet — retry with the legacy statement so caching keeps working.
        await db
          .prepare(
            `INSERT INTO actors
             (id, username, domain, display_name, summary, avatar_url, header_url,
              public_key_pem, private_key_pem, is_local, is_bot,
              manually_approves_followers, discoverable,
              followers_count, following_count, statuses_count, inbox, also_known_as)
             VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?,1,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               display_name = excluded.display_name,
               summary = CASE WHEN excluded.summary IS NOT NULL THEN excluded.summary ELSE actors.summary END,
               avatar_url = CASE WHEN excluded.avatar_url IS NOT NULL THEN excluded.avatar_url ELSE actors.avatar_url END,
               header_url = CASE WHEN excluded.header_url IS NOT NULL THEN excluded.header_url ELSE actors.header_url END,
               public_key_pem = excluded.public_key_pem,
               manually_approves_followers = excluded.manually_approves_followers,
               discoverable = excluded.discoverable,
               followers_count = CASE WHEN excluded.followers_count > 0 THEN excluded.followers_count ELSE actors.followers_count END,
               following_count = CASE WHEN excluded.following_count > 0 THEN excluded.following_count ELSE actors.following_count END,
               statuses_count = CASE WHEN excluded.statuses_count > 0 THEN excluded.statuses_count ELSE actors.statuses_count END,
               inbox = excluded.inbox,
               also_known_as = excluded.also_known_as,
               updated_at = datetime('now')`
          )
          .bind(
            id, usernameNorm, domain,
            displayName,
            summary,
            iconUrl,
            imageUrl,
            pubKey,
            (p.type as string) === "Service" ? 1 : 0,
            (p.manuallyApprovesFollowers as boolean) ? 1 : 0,
            followersCount,
            followingCount,
            statusesCount,
            inbox,
            alsoKnownAs,
          )
          .run();
      }
    } catch {
      // UNIQUE(username, domain) conflict — update the existing row's id so
      // subsequent getActorById(id) lookups work correctly.
      try {
        await db
          .prepare(
            `UPDATE actors SET
               id = ?, display_name = ?,
               summary = CASE WHEN ? IS NOT NULL THEN ? ELSE summary END,
               avatar_url = CASE WHEN ? IS NOT NULL THEN ? ELSE avatar_url END,
               header_url = CASE WHEN ? IS NOT NULL THEN ? ELSE header_url END,
               public_key_pem = ?, manually_approves_followers = ?,
               followers_count = CASE WHEN ? > 0 THEN ? ELSE followers_count END,
               following_count = CASE WHEN ? > 0 THEN ? ELSE following_count END,
               statuses_count  = CASE WHEN ? > 0 THEN ? ELSE statuses_count  END,
               discoverable = ?, inbox = ?, also_known_as = ?, updated_at = datetime('now')
             WHERE username = ? AND domain = ?`
          )
          .bind(
            id,
            displayName,
            summary,
            summary,
            iconUrl,
            iconUrl,
            imageUrl,
            imageUrl,
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
            alsoKnownAs,
            usernameNorm,
            domain,
          )
          .run();
      } catch { /* ignore */ }
    }

    // Save profile fields (PropertyValue attachments)
    try {
      const attachment = p.attachment;
      const fields: { name: string; value: string }[] = [];
      if (Array.isArray(attachment)) {
        for (const entry of attachment) {
          const e = entry as Record<string, unknown>;
          if (e.type === "PropertyValue" && typeof e.name === "string" && typeof e.value === "string") {
            fields.push({ name: e.name, value: e.value });
          }
        }
      }
      await setActorFields(db, id, fields);
    } catch { /* ignore field errors */ }

    // Cache the actor's own custom emoji (from the profile's `tag` list) so
    // remote bios render :emoji: shortcodes even before any post is ingested.
    if (Array.isArray(p.tag)) {
      for (const tag of p.tag) {
        const t = tag as { type?: string; name?: string; id?: string; icon?: { url?: string } };
        if (t.type === "Emoji" && t.name && t.icon?.url) {
          const shortcode = t.name.replace(/^:|:$/g, "");
          if (shortcode) {
            try {
              await upsertCustomEmoji(db, {
                id: t.id ?? generateId(),
                shortcode,
                url: t.icon.url,
                staticUrl: t.icon.url,
                domain,
                visibleInPicker: false,
              });
            } catch { /* ignore invalid emoji */ }
          }
        }
      }
    }

    // Probe domain call support (fire-and-forget to avoid blocking the response)
    void probeDomainCallsSupport(db, domain);

    return { id, inbox, domain };
  } catch {
    return null;
  }
}

/**
 * Resolve the visibility of a fediverse status from its AP audience.
 * Mirrors the inbox's resolveVisibility so outbox-ingested objects line up.
 */
function outboxVisibility(to: unknown, cc: unknown): "public" | "unlisted" | "followers" | "direct" {
  const toArr: string[] = Array.isArray(to) ? to : (to ? [to as string] : []);
  const ccArr: string[] = Array.isArray(cc) ? cc : (cc ? [cc as string] : []);
  const isPublic = (v: string) =>
    v === "https://www.w3.org/ns/activitystreams#Public" ||
    v === "http://www.w3.org/ns/activitystreams#Public" ||
    v === "as:Public" ||
    v === "Public";
  if (toArr.some(isPublic)) return "public";
  if (ccArr.some(isPublic)) return "unlisted";
  if (toArr.some((t) => t.includes("/followers"))) return "followers";
  return "direct";
}

/** Normalize an object's presentation URL (string, Link, or array of both). */
function outboxObjectUrl(url: unknown, fallback: string): string {
  if (typeof url === "string") return url;
  if (Array.isArray(url)) {
    for (const u of url) {
      if (typeof u === "string") return u;
      if (u && typeof u === "object") {
        const href = (u as Record<string, unknown>).href;
        if (typeof href === "string") return href;
      }
    }
    return fallback;
  }
  if (url && typeof url === "object") {
    const href = (url as Record<string, unknown>).href;
    if (typeof href === "string") return href;
  }
  return fallback;
}

/** Parse a remote collection/collection page into its item entries. */
async function fetchOutboxItems(
  outboxUrl: string,
  pageUrl?: string,
  limit = 20
): Promise<unknown[]> {
  const fetched = await fetchRemoteObject(pageUrl ?? outboxUrl);
  if (!fetched || typeof fetched !== "object") return [];

  const doc = fetched as Record<string, unknown>;
  const items = Array.isArray(doc.orderedItems)
    ? doc.orderedItems
    : Array.isArray(doc.items)
      ? doc.items
      : [];

  if (items.length > 0) return items.slice(0, limit);

  // Collection envelope: first page is referenced by URL (Mastodon style).
  const first = doc.first;
  if (typeof first === "string" && first.startsWith("https://")) {
    const page = await fetchRemoteObject(first);
    if (page && typeof page === "object") {
      const pageDoc = page as Record<string, unknown>;
      const pageItems = Array.isArray(pageDoc.orderedItems)
        ? pageDoc.orderedItems
        : Array.isArray(pageDoc.items)
          ? pageDoc.items
          : [];
      return pageItems.slice(0, limit);
    }
  }
  if (first && typeof first === "object") {
    const firstDoc = first as Record<string, unknown>;
    const firstItems = Array.isArray(firstDoc.orderedItems)
      ? firstDoc.orderedItems
      : Array.isArray(firstDoc.items)
        ? firstDoc.items
        : [];
    return firstItems.slice(0, limit);
  }
  return [];
}

/**
 * Poll the first page of a remote actor's outbox and ingest the public/visible
 * Notes into the local objects table so their profile pages show content even
 * when none of their statuses were ever federated to this instance.
 *
 * Idempotent: already-stored objects (by AP id) are skipped.
 */
export async function fetchAndCacheRemoteActorStatuses(
  db: D1Database,
  actorId: string,
  limit = 20
): Promise<number> {
  const actor = await getActorById(db, actorId);
  if (!actor || actor.isLocal) return 0;

  const outboxUrl = `${actorId.replace(/\/+$/, "")}/outbox`;

  const items = await fetchOutboxItems(outboxUrl, undefined, limit);
  let ingested = 0;

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") continue;

    // Outbox entries can be activities (Create{object}) or bare objects.
    const item = rawItem as Record<string, unknown>;
    let obj = item;
    if (typeof item.type === "string" && String(item.type).toLowerCase() === "create") {
      const inner = item.object;
      if (typeof inner === "string") continue;
      if (inner && typeof inner === "object") obj = inner as Record<string, unknown>;
    }
    if (!obj || typeof obj !== "object") continue;

    // Only store content-bearing objects (Note/Article/Video/Image/Question…).
    const objType = String(obj.type ?? "").split("/").pop() ?? "";
    if (!isContentObjectType(objType)) continue;

    const oid = obj.id as string | undefined;
    if (!oid) continue;

    // Idempotency: skip anything we already have.
    if (await getObjectById(db, oid)) continue;

    // Only surface public/unlisted statuses from an outbox fetch. Direct and
    // followers-only posts must arrive via the real inbox to be counted.
    const visibility = outboxVisibility(obj.to, obj.cc);
    if (visibility !== "public" && visibility !== "unlisted") continue;

    const sanitized = sanitizeRemoteNoteContent(
      obj.content as string | undefined,
      obj.summary as string | undefined,
      obj.sensitive === true
    );

    const published = toIso(obj.published);
    try {
      await createObject(db, {
        id: oid,
        type: objType,
        actorId,
        content: sanitized.content,
        contentWarning: sanitized.contentWarning,
        sensitive: obj.sensitive === true,
        visibility,
        inReplyToId: (obj.inReplyTo as string) ?? null,
        quoteId: extractQuoteId(obj as Record<string, unknown>),
        language: obj.contentMap ? Object.keys(obj.contentMap)[0] : null,
        url: outboxObjectUrl(obj.url, oid),
        repliesCount: 0,
        reblogsCount: 0,
        favouritesCount: 0,
        published,
        local: false,
        raw: JSON.stringify(obj),
      });

      // Inline attachments (remote objects reference of their URLs).
      await storeObjectAttachments(db, oid, obj.attachment as APAttachment[] | undefined, obj.sensitive === true);

      // Backfill poll rows for Question objects.
      if (objType === "Question") {
        try { await ensureOutboxPollRows(db, obj as unknown as APNote); } catch { /* ignore */ }
      }

      ingested++;
    } catch {
      /* object insert may race / conflict; ignore and keep going */
    }
  }

  return ingested;
}

/**
 * Persist a remote object's inline attachments (idempotent per attachment).
 */
async function storeObjectAttachments(
  db: D1Database,
  objectId: string,
  attachment: APAttachment[] | undefined,
  sensitive = false
): Promise<void> {
  if (!Array.isArray(attachment)) return;
  for (const att of attachment) {
    if (!att?.url || typeof att.url !== "string") continue;
    try {
      await createAttachment(db, {
        id: att.id || generateId(),
        objectId,
        type: apAttachmentType(att.type, att.mediaType),
        url: att.url,
        remoteUrl: att.url,
        description: att.name ?? null,
        blurhash: att.blurhash ?? null,
        width: att.width ?? null,
        height: att.height ?? null,
        fileSize: null,
        mimeType: att.mediaType ?? null,
        sensitive: sensitive || (att as { sensitive?: boolean }).sensitive === true,
        createdAt: new Date().toISOString(),
      });
    } catch { /* ignore duplicate/conflict */ }
  }
}

/**
 * Fetch a single remote status by its URL and cache it locally (actor + object
 * + attachments). Idempotent: returns the already-stored object if present.
 * Used by search/explore to resolve pasted federated status URLs.
 */
export async function fetchAndCacheRemoteStatus(
  db: D1Database,
  url: string
): Promise<{ object: LocalObject | null; actor: LocalActor | null }> {
  const val = validateOutboundUrl(url);
  if (!val.valid) return { object: null, actor: null };
  try {
    const fetched = await fetchRemoteObject(url);
    if (!fetched || typeof fetched !== "object") return { object: null, actor: null };

    const obj = fetched as Record<string, unknown>;
    const objType = String(obj.type ?? "").split("/").pop() ?? "";
    if (!isContentObjectType(objType)) return { object: null, actor: null };

    const oid = (obj.id as string) ?? url;
    if (!oid) return { object: null, actor: null };

    // Idempotency: return the already-stored copy when present.
    const existing = await getObjectById(db, oid);
    if (existing) return { object: existing, actor: await getActorById(db, existing.actorId) };

    const sanitized = sanitizeRemoteNoteContent(
      obj.content as string | undefined,
      obj.summary as string | undefined,
      obj.sensitive === true
    );

    const attributedTo = (obj.attributedTo as string) ?? (obj.actor as string);
    if (!attributedTo) return { object: null, actor: null };
    const cachedActor = await fetchAndCacheRemoteActor(db, attributedTo);
    if (!cachedActor) return { object: null, actor: null };

    const visibility = outboxVisibility(obj.to, obj.cc);
    if (visibility !== "public" && visibility !== "unlisted") return { object: null, actor: null };

    await createObject(db, {
      id: oid,
      type: objType,
      actorId: cachedActor.id,
      content: sanitized.content,
      contentWarning: sanitized.contentWarning,
      sensitive: obj.sensitive === true,
      visibility,
      inReplyToId: (obj.inReplyTo as string) ?? null,
      quoteId: extractQuoteId(obj as Record<string, unknown>),
      language: obj.contentMap ? Object.keys(obj.contentMap)[0] : null,
      url: outboxObjectUrl(obj.url, oid),
      repliesCount: 0,
      reblogsCount: 0,
      favouritesCount: 0,
      published: toIso(obj.published),
      local: false,
      raw: JSON.stringify(obj),
    });

    await storeObjectAttachments(db, oid, obj.attachment as APAttachment[] | undefined, obj.sensitive === true);
    if (objType === "Question") {
      try { await ensureOutboxPollRows(db, obj as unknown as APNote); } catch { /* ignore */ }
    }

    const object = await getObjectById(db, oid);
    return { object, actor: object ? await getActorById(db, object.actorId) : null };
  } catch {
    return { object: null, actor: null };
  }
}

/**
 * Fetch a remote actor's pinned posts (the ActivityPub `featured` collection,
 * usually at <actorId>/collections/featured) and ingest them into the local
 * objects table + status_pins, so remote profile "pinned" tabs work like local
 * ones. Idempotent: already-stored objects are skipped and pins use OR IGNORE.
 */
export async function fetchAndCacheRemoteActorFeatured(
  db: D1Database,
  actorId: string
): Promise<number> {
  const actor = await getActorById(db, actorId);
  if (!actor || actor.isLocal) return 0;

  const featuredUrl = `${actorId.replace(/\/+$/, "")}/collections/featured`;
  const items = await fetchOutboxItems(featuredUrl, undefined, 20);
  let pinned = 0;

  for (const rawItem of items) {
    // Featured entries are status URLs (strings) or embedded objects.
    let item: Record<string, unknown>;
    if (typeof rawItem === "string") {
      try {
        const fetched = await fetchRemoteObject(rawItem);
        if (fetched && typeof fetched === "object") item = fetched as Record<string, unknown>;
        else continue;
      } catch {
        continue;
      }
    } else if (rawItem && typeof rawItem === "object") {
      item = rawItem as Record<string, unknown>;
    } else {
      continue;
    }

    const oid = item.id as string | undefined;
    if (!oid) continue;

    const objType = String(item.type ?? "").split("/").pop() ?? "";
    if (!isContentObjectType(objType)) continue;

    // Store the object if not already present.
    if (!(await getObjectById(db, oid))) {
      const visibility = outboxVisibility(item.to, item.cc);
      if (visibility !== "public" && visibility !== "unlisted") continue;
      const sanitized = sanitizeRemoteNoteContent(
        item.content as string | undefined,
        item.summary as string | undefined,
        item.sensitive === true
      );
      try {
        await createObject(db, {
          id: oid,
          type: objType,
          actorId,
          content: sanitized.content,
          contentWarning: sanitized.contentWarning,
          sensitive: item.sensitive === true,
          visibility,
          inReplyToId: (item.inReplyTo as string) ?? null,
          quoteId: extractQuoteId(item as Record<string, unknown>),
          language: item.contentMap ? Object.keys(item.contentMap)[0] : null,
          url: outboxObjectUrl(item.url, oid),
          repliesCount: 0,
          reblogsCount: 0,
          favouritesCount: 0,
          published: toIso(item.published),
          local: false,
          raw: JSON.stringify(item),
        });

        // Inline attachments.
        if (Array.isArray(item.attachment)) {
          for (const attachment of item.attachment as APAttachment[]) {
            if (!attachment?.url || typeof attachment.url !== "string") continue;
            const localAttachment: LocalAttachment = {
              id: attachment.id || generateId(),
              objectId: oid,
              type: apAttachmentType(attachment.type, attachment.mediaType),
              url: attachment.url,
              remoteUrl: attachment.url,
              description: attachment.name ?? null,
              blurhash: attachment.blurhash ?? null,
              width: attachment.width ?? null,
              height: attachment.height ?? null,
              fileSize: null,
              mimeType: attachment.mediaType ?? null,
              sensitive: item.sensitive === true || (attachment as { sensitive?: boolean }).sensitive === true,
              createdAt: new Date().toISOString(),
            };
            try { await createAttachment(db, localAttachment); } catch { /* ignore */ }
          }
        }
      } catch {
        /* insert may race; ignore */
      }
    }

    // Record the pin (idempotent).
    try {
      await db
        .prepare("INSERT OR IGNORE INTO status_pins (id, actor_id, status_id) VALUES (?, ?, ?)")
        .bind(generateId(), actorId, oid)
        .run();
      pinned++;
    } catch { /* ignore */ }
  }

  return pinned;
}

function toIso(dateStr: unknown): string {
  if (typeof dateStr === "string") {
    try { return new Date(dateStr).toISOString(); } catch { /* fallthrough */ }
  }
  return new Date().toISOString();
}

function safe(dateStr: unknown): string {
  try { return new Date(String(dateStr)).toISOString(); } catch { return new Date().toISOString(); }
}

/** Create poll rows for a Question ingested from a remote outbox. */
async function ensureOutboxPollRows(db: D1Database, obj: APNote): Promise<void> {
  if (await getPollByObjectId(db, obj.id)) return;
  const single = Array.isArray(obj.oneOf) ? obj.oneOf : [];
  const multi = Array.isArray(obj.anyOf) ? obj.anyOf : [];
  const choices = single.length > 0 ? single : multi;
  if (choices.length === 0) return;
  const expiresAt = typeof obj.endTime === "string"
    ? safe(obj.endTime)
    : new Date(Date.now() + 24 * 36e5).toISOString();
  await createPoll(db, {
    id: generateId(),
    objectId: obj.id,
    expiresAt,
    multiple: multi.length > 0,
    options: choices.map((opt, i) => ({
      id: generateId(),
      title: typeof opt?.name === "string" ? opt.name : `Opción ${i + 1}`,
      position: i,
    })),
  });
}


/**
 * Best-effort extraction of profile details from an actor's HTML profile page.
 * Some implementations (Friendica/DFRN and other minimal servers) serve an AP
 * actor document without icon/summary; the details only exist in the HTML.
 * Parses OpenGraph meta tags and the h-card `u-photo` microformat, which cover
 * Mastodon, Friendica and most fediverse front-ends. SSRF-guarded and bounded.
 */
export async function fetchProfileHtmlFallback(
  profileUrl: string
): Promise<{ avatar?: string; summary?: string }> {
  const val = validateOutboundUrl(profileUrl);
  if (!val.valid) return {};

  try {
    const res = await remoteFetch(profileUrl, {
      Accept: "text/html,application/xhtml+xml",
    });
    if (!res?.ok) return {};
    const html = await res.text();
    if (html.length > 2_000_000) return {};

    const out: { avatar?: string; summary?: string } = {};

    // Avatar: og:image (attribute order varies) → h-card u-photo → apple icon.
    const ogImage = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    ) ?? html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
    );
    const uPhoto = html.match(
      /class=["'][^"']*\bu-photo\b[^"']*["'][^>]*src=["']([^"']+)["']/i
    );
    const appleIcon = html.match(
      /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i
    );
    const avatar = ogImage?.[1] ?? uPhoto?.[1] ?? appleIcon?.[1];
    if (avatar) out.avatar = avatar;

    // Description: og:description or <meta name="description">.
    const desc = html.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
    ) ?? html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
    );
    if (desc?.[1]) out.summary = desc[1];

    return out;
  } catch {
    return {};
  }
}
