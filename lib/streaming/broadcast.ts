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
    await getStub(ns).fetch(`${DO_HOST}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, event, payload }),
    });
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
 * Broadcast a WebRTC call event to a specific user's home channel.
 * The event type is "call" and the payload is the JSON-serialised CallEventPayload.
 */
export async function broadcastCallEvent(
  ns: DONamespace,
  targetUsername: string,
  payload: unknown
): Promise<void> {
  await broadcastToChannel(ns, `home:${targetUsername}`, "call", JSON.stringify(payload));
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
  obj: { id: string; local: boolean; visibility: string; actorId: string; raw?: string | null }
): Promise<void> {
  const encodedStatusId = encodeStatusId(obj.id, obj.local);
  const isPublic = obj.visibility === "public";
  const tasks: Promise<void>[] = [
    broadcastDelete(ns, encodedStatusId, isPublic, obj.local),
  ];

  // Local followers' home feeds.
  try {
    const followerRows = await db
      .prepare("SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1")
      .bind(obj.actorId)
      .all<{ id: string }>();
    for (const row of followerRows.results) {
      tasks.push(broadcastHomeDelete(ns, row.id, encodedStatusId));
    }
  } catch { /* ignore */ }

  // Hashtag timelines.
  for (const tag of extractHashtagNames(obj.raw ?? undefined)) {
    tasks.push(broadcastToChannel(ns, `hashtag:${tag}`, "delete", encodedStatusId));
  }

  // List timelines containing the author.
  try {
    const listRows = await db
      .prepare("SELECT DISTINCT la.list_id FROM list_accounts la WHERE la.actor_id = ?")
      .bind(obj.actorId)
      .all<{ list_id: string }>();
    for (const row of listRows.results) {
      tasks.push(broadcastToChannel(ns, `list:${row.list_id}`, "delete", encodedStatusId));
    }
  } catch { /* ignore */ }

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
