/**
 * Server-side helpers to broadcast Mastodon streaming events to connected
 * WebSocket clients via the TimelineStreamDO Durable Object.
 *
 * All functions are fire-and-forget: failures are logged but never propagate
 * to the caller so that request handling is never blocked by streaming errors.
 */

// Use a structural type to avoid @cloudflare/workers-types version mismatches.
export type DONamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string | URL, init?: RequestInit): Promise<Response> };
};

// Structural D1 type (avoids @cloudflare/workers-types version mismatches).
type D1DatabaseLike = {
  prepare(sql: string): {
    bind(...args: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
  };
};

import { encodeStatusId } from "@/lib/mastodon/statusId";

const DO_HOST = "https://timeline-do";

function getStub(ns: DONamespace) {
  return ns.get(ns.idFromName("timeline"));
}

/**
 * Broadcast a single Mastodon streaming event to all clients subscribed to
 * the given channel.
 */
export async function broadcastToChannel(
  ns: DONamespace,
  channel: string,
  event: string,
  payload: string
): Promise<void> {
  try {
    const res = await getStub(ns).fetch(`${DO_HOST}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, event, payload }),
    });
    // The DO response is not needed; an unread body would count against the
    // runtime's in-flight fetch pool (stalled-response cancellation).
    await res.body?.cancel().catch(() => {});
  } catch (err) {
    console.error(`[streaming] broadcastToChannel(${channel}) failed:`, err);
  }
}

/**
 * Broadcast a new status to the federated timeline and, if the status is from
 * a local actor, also to the local-only public timeline.
 *
 * Only `public` statuses appear on the public/federated timelines — `unlisted`
 * statuses stay out of them (they are still visible on profiles and to
 * followers, via the home timeline). The REST endpoints already filter on
 * `visibility = 'public'`, so broadcasting unlisted here would show a status
 * that disappears on reload. Guard on visibility so the streaming path matches.
 */
export async function broadcastPublicStatus(
  ns: DONamespace,
  status: unknown,
  isLocal: boolean
): Promise<void> {
  if ((status as { visibility?: string }).visibility !== "public") return;
  const payload = JSON.stringify(status);
  const tasks: Promise<void>[] = [
    broadcastToChannel(ns, "public", "update", payload),
  ];
  if (isLocal) {
    tasks.push(broadcastToChannel(ns, "public:local", "update", payload));
  } else {
    // Remote statuses go to the "public:remote" channel in addition to "public"
    tasks.push(broadcastToChannel(ns, "public:remote", "update", payload));
  }
  await Promise.allSettled(tasks);
}

/**
 * Broadcast a new status to the home timeline channel of a specific actor.
 * Used both for the actor's own posts and for posts from accounts they follow.
 */
/** Extract the local username from an actor IRI like https://domain/users/alice → "alice" */
function actorUsername(actorId: string): string {
  return actorId.split("/").pop() ?? actorId;
}

export async function broadcastHomeStatus(
  ns: DONamespace,
  actorId: string,
  status: unknown
): Promise<void> {
  await broadcastToChannel(ns, `home:${actorUsername(actorId)}`, "update", JSON.stringify(status));
}

/**
 * Notify a local actor that they have a new notification.
 * Broadcasts to both:
 *  - "home:{username}"         → `user` stream subscribers (home + notifications)
 *  - "notification:{username}" → `user:notification` stream subscribers (notifications only)
 *
 * Pass the serialized MastodonNotification as `payload` when available so that
 * clients that support rich notification payloads can display them immediately.
 * Falls back to "{}" when not provided (clients will fetch via REST).
 */
export async function broadcastNotificationEvent(
  ns: DONamespace,
  targetActorId: string,
  payload = "{}"
): Promise<void> {
  const username = actorUsername(targetActorId);
  await Promise.allSettled([
    broadcastToChannel(ns, `home:${username}`, "notification", payload),
    broadcastToChannel(ns, `notification:${username}`, "notification", payload),
  ]);
}

/**
 * Notify a user that their filters changed so clients can refetch them.
 * Mirrors Mastodon's `filters_changed` event on the home timeline channel.
 */
export async function broadcastFiltersChanged(ns: DONamespace, targetUsername: string): Promise<void> {
  await broadcastToChannel(ns, `home:${targetUsername}`, "filters_changed", "{}");
}

/**
 * Send one typed event to a local actor's connected clients. This is the single
 * generic emitter for everything that is not a timeline event: profile pages
 * refetch a relationship when the inbox changes it (`relationship`), the call
 * overlay receives its signalling messages (`call`)… The event name is the
 * type and `data` is the JSON payload, so adding a new client-side notification
 * never needs a new helper.
 */
export async function broadcastEvent(
  ns: DONamespace,
  targetActorId: string,
  type: string,
  data: unknown = {}
): Promise<void> {
  await broadcastToChannel(ns, `home:${actorUsername(targetActorId)}`, type, JSON.stringify(data));
}

/**
 * Broadcast a status deletion to all relevant channels.
 */
export async function broadcastDelete(
  ns: DONamespace,
  statusId: string,
  isPublic: boolean,
  isLocal: boolean
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (isPublic) {
    tasks.push(broadcastToChannel(ns, "public", "delete", statusId));
    if (isLocal) {
      tasks.push(broadcastToChannel(ns, "public:local", "delete", statusId));
    } else {
      tasks.push(broadcastToChannel(ns, "public:remote", "delete", statusId));
    }
  }
  await Promise.allSettled(tasks);
}

/**
 * Broadcast a delete event to a specific actor's home channel.
 */
export async function broadcastHomeDelete(
  ns: DONamespace,
  actorId: string,
  statusId: string
): Promise<void> {
  await broadcastToChannel(ns, `home:${actorUsername(actorId)}`, "delete", statusId);
}

/** Extract hashtag names (lowercased, without "#") from a stored object's raw AP JSON. */
function extractHashtagNames(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { tag?: unknown };
    const tags = Array.isArray(parsed.tag) ? parsed.tag : [];
    const names: string[] = [];
    for (const t of tags) {
      const tag = t as { type?: string; name?: string };
      if (tag.type === "Hashtag" && typeof tag.name === "string") {
        names.push(tag.name.replace(/^#/, "").toLowerCase());
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Broadcast a status deletion to EVERY timeline that could show it: public
 * (federated/local/remote), home feeds of local followers, hashtag channels the
 * object is tagged with, and list channels containing the author. Used by both
 * local deletions and inbound federated deletes so connected clients remove the
 * status live without a reload.
 */
export async function broadcastObjectDelete(
  ns: DONamespace,
  db: D1DatabaseLike,
  obj: { id: string; local: boolean; visibility: string; actorId: string; raw?: string | null },
  /** Precomputed audience for bulk deletes (auto-delete): avoids two queries
   *  per object when many statuses of one author are removed in a batch. */
  audience?: { followers?: string[]; lists?: string[] }
): Promise<void> {
  const encodedStatusId = encodeStatusId(obj.id, obj.local);
  const isPublic = obj.visibility === "public";
  const tasks: Promise<void>[] = [
    broadcastDelete(ns, encodedStatusId, isPublic, obj.local),
  ];

  // The author's own home channel: their client shows the deleted status in
  // its cached feed until this event arrives (auto-delete has no DELETE
  // request from the UI to filter it locally).
  if (obj.local) {
    tasks.push(broadcastHomeDelete(ns, obj.actorId, encodedStatusId));
  }

  // Local followers' home feeds.
  if (audience?.followers) {
    for (const followerId of audience.followers) {
      tasks.push(broadcastHomeDelete(ns, followerId, encodedStatusId));
    }
  } else {
    try {
      const followerRows = await db
        .prepare("SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1")
        .bind(obj.actorId)
        .all<{ id: string }>();
      for (const row of followerRows.results) {
        tasks.push(broadcastHomeDelete(ns, row.id, encodedStatusId));
      }
    } catch { /* ignore */ }
  }

  // Hashtag timelines.
  for (const tag of extractHashtagNames(obj.raw ?? undefined)) {
    tasks.push(broadcastToChannel(ns, `hashtag:${tag}`, "delete", encodedStatusId));
  }

  // List timelines containing the author. List timelines only ever show
  // public/unlisted posts (getListTimeline), so private/direct deletions are
  // not broadcast there. NOTE: this used to read the DOM global `status`
  // instead of `obj.visibility` — it always threw inside the try/catch, so
  // lists never received delete events (and the early `return` skipped the
  // `allSettled` below).
  if (obj.visibility === "public" || obj.visibility === "unlisted") {
    if (audience?.lists) {
      for (const listId of audience.lists) {
        tasks.push(broadcastToChannel(ns, `list:${listId}`, "delete", encodedStatusId));
      }
    } else {
      try {
        const listRows = await db
          .prepare("SELECT DISTINCT la.list_id FROM list_accounts la WHERE la.actor_id = ?")
          .bind(obj.actorId)
          .all<{ list_id: string }>();
        for (const row of listRows.results) {
          tasks.push(broadcastToChannel(ns, `list:${row.list_id}`, "delete", encodedStatusId));
        }
      } catch { /* ignore */ }
    }
  }

  await Promise.allSettled(tasks);
}

/**
 * Broadcast a status.update event (status was edited) to public channels.
 */
export async function broadcastStatusUpdate(
  ns: DONamespace,
  status: unknown,
  isLocal: boolean
): Promise<void> {
  const payload = JSON.stringify(status);
  const visibility = (status as { visibility?: string }).visibility;
  const tasks: Promise<void>[] = [];
  if (visibility === "public") {
    tasks.push(broadcastToChannel(ns, "public", "status.update", payload));
    if (isLocal) {
      tasks.push(broadcastToChannel(ns, "public:local", "status.update", payload));
    }
  }
  await Promise.allSettled(tasks);
}

/**
 * Broadcast a status.update event to a specific actor's home channel.
 */
export async function broadcastHomeStatusUpdate(
  ns: DONamespace,
  actorId: string,
  status: unknown
): Promise<void> {
  await broadcastToChannel(ns, `home:${actorUsername(actorId)}`, "status.update", JSON.stringify(status));
}

/**
 * Broadcast fresh counters/content of an existing status after an interaction
 * (favourite, reblog, reply). The payload is the full serialized status, so
 * clients replace the cached copy and pick up new counts, edits and states.
 * Emitted to the public/local channels (like edits) plus the author's home.
 */
export async function broadcastStatusInteraction(
  ns: DONamespace,
  status: unknown,
  author: { id: string; isLocal: boolean }
): Promise<void> {
  const tasks: Promise<void>[] = [
    broadcastStatusUpdate(ns, status, author.isLocal),
  ];
  if (author.isLocal) {
    tasks.push(broadcastHomeStatusUpdate(ns, author.id, status));
  }
  await Promise.allSettled(tasks);
}

/**
 * Push the current state of a status to every audience that may be showing it:
 * public channels, the home feeds of the author's local followers (plus the
 * author) and every list containing the author. Used when data that was
 * initially missing becomes available — e.g. a link preview card crawled after
 * the status was delivered — so clients update without a manual refresh.
 */
export async function broadcastStatusRefresh(
  db: StreamDb,
  ns: DONamespace,
  status: unknown,
  author: { id: string; isLocal: boolean }
): Promise<void> {
  await broadcastToAuthorAudience(db, ns, status, author, "status.update");
}

/**
 * Refresh a status on the list channels that contain its author (lists are
 * user-configured feeds; the members' counter/content updates belong there).
 */
export async function broadcastStatusInteractionToLists(
  db: { prepare(sql: string): { bind(...args: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> } } },
  ns: DONamespace,
  authorId: string,
  status: unknown,
  event: "update" | "status.update" = "status.update"
): Promise<void> {
  try {
    // List timelines only ever show public/unlisted posts (getListTimeline).
    // Broadcasting private/direct payloads to list channels leaked them to
    // anyone able to subscribe to a list channel.
    const visibility = (status as { visibility?: string } | null)?.visibility;
    if (visibility !== "public" && visibility !== "unlisted") return;
    const listRows = await db
      .prepare("SELECT DISTINCT la.list_id FROM list_accounts la WHERE la.actor_id = ?")
      .bind(authorId)
      .all<{ list_id: string }>();
    const payload = JSON.stringify(status);
    const tasks = listRows.results.map((row) =>
      broadcastToChannel(ns, `list:${row.list_id}`, event, payload)
    );
    await Promise.allSettled(tasks);
  } catch { /* ignore */ }
}

type StreamDb = { prepare(sql: string): { bind(...args: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> } } };

/**
 * Actor row (id + domain) whose content a viewer may have blocked. A missing
 * row still excludes by id (its domain is simply unknown).
 */
export async function actorExclusion(
  db: D1DatabaseLike,
  actorId: string
): Promise<{ id: string; domain: string | null }> {
  try {
    const rows = await db
      .prepare("SELECT id, domain FROM actors WHERE id = ? LIMIT 1")
      .bind(actorId)
      .all<{ id: string; domain: string | null }>();
    return rows.results?.[0] ?? { id: actorId, domain: null };
  } catch {
    return { id: actorId, domain: null };
  }
}

/** Parent author (id + domain) of a reply, when the parent object is cached. */
export async function parentExclusion(
  db: D1DatabaseLike,
  inReplyToId: string | null | undefined
): Promise<{ id: string; domain: string | null } | null> {
  if (!inReplyToId) return null;
  try {
    const rows = await db
      .prepare(
        `SELECT a.id AS id, a.domain AS domain FROM objects o JOIN actors a ON a.id = o.actor_id WHERE o.id = ? LIMIT 1`
      )
      .bind(inReplyToId)
      .all<{ id: string; domain: string | null }>();
    return rows.results?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Local actors among `recipientIds` who have not blocked any of the excluded
 * accounts (nor their domains): the same per-viewer filters the REST timelines
 * apply, so a live event never shows what the next reload would hide.
 */
export async function eligibleLocalRecipients(
  db: D1DatabaseLike,
  recipientIds: string[],
  excluded: { id: string; domain: string | null }[]
): Promise<string[]> {
  if (recipientIds.length === 0) return [];
  let sql = `SELECT a.id FROM actors a
    WHERE a.is_local = 1 AND a.id IN (SELECT value FROM json_each(?))`;
  const binds: unknown[] = [JSON.stringify(recipientIds)];
  for (const account of excluded) {
    sql += " AND a.id NOT IN (SELECT actor_id FROM blocks WHERE target_id = ?)";
    binds.push(account.id);
    if (account.domain) {
      sql += " AND NOT EXISTS (SELECT 1 FROM domain_blocks db WHERE db.actor_id = a.id AND db.domain = ?)";
      binds.push(account.domain);
    }
  }
  const rows = await db.prepare(sql).bind(...binds).all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

/** Fan a status out to the author's audience using insert or replace events. */
async function broadcastToAuthorAudience(
  db: StreamDb,
  ns: DONamespace,
  status: unknown,
  author: { id: string; isLocal: boolean },
  kind: "update" | "status.update"
): Promise<void> {
  const tasks: Promise<void>[] = [
    kind === "update"
      ? broadcastPublicStatus(ns, status, author.isLocal)
      : broadcastStatusUpdate(ns, status, author.isLocal),
    broadcastStatusInteractionToLists(db, ns, author.id, status, kind),
  ];
  // Direct messages never go to followers' home feeds.
  const visibility = (status as { visibility?: string } | null)?.visibility;
  if (visibility !== "direct") {
    try {
      const followers = await db
        .prepare(
          `SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id
           WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1`
        )
        .bind(author.id)
        .all<{ id: string }>();
      // Mirror the REST timeline filters: recipients who blocked the author
      // (or its domain) and those who blocked the parent of a reply stay out.
      const exclusions = [await actorExclusion(db, author.id)];
      const parentAccountId =
        (status as { in_reply_to_account_id?: string | null } | null)?.in_reply_to_account_id ?? null;
      if (parentAccountId) exclusions.push(await actorExclusion(db, parentAccountId));
      const recipients = await eligibleLocalRecipients(
        db,
        (followers.results ?? []).map((row) => row.id),
        exclusions
      );
      for (const recipientId of recipients) {
        tasks.push(
          kind === "update"
            ? broadcastHomeStatus(ns, recipientId, status)
            : broadcastHomeStatusUpdate(ns, recipientId, status)
        );
      }
    } catch { /* streaming refresh is best-effort */ }
  }
  if (author.isLocal) {
    tasks.push(
      kind === "update"
        ? broadcastHomeStatus(ns, author.id, status)
        : broadcastHomeStatusUpdate(ns, author.id, status)
    );
  }
  await Promise.allSettled(tasks);
}

/**
 * Announce a status that was not in timelines before (it was held while its
 * remote media was cached): home/public/list clients insert it in place.
 */
export async function broadcastStatusCreatedToAudience(
  db: StreamDb,
  ns: DONamespace,
  status: unknown,
  author: { id: string; isLocal: boolean }
): Promise<void> {
  await broadcastToAuthorAudience(db, ns, status, author, "update");
}
