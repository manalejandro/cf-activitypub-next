/**
 * Server-side helpers to broadcast Mastodon streaming events to connected
 * WebSocket clients via the TimelineStreamDO Durable Object.
 *
 * All functions are fire-and-forget: failures are logged but never propagate
 * to the caller so that request handling is never blocked by streaming errors.
 */

// Use a structural type to avoid @cloudflare/workers-types version mismatches.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DONamespace = { idFromName(name: string): any; get(id: any): { fetch(input: string | URL, init?: RequestInit): Promise<Response> } };

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
 * Broadcast a new public status to the federated timeline and, if the status
 * is from a local actor, also to the local-only public timeline.
 */
export async function broadcastPublicStatus(
  ns: DONamespace,
  status: unknown,
  isLocal: boolean
): Promise<void> {
  const payload = JSON.stringify(status);
  const tasks: Promise<void>[] = [
    broadcastToChannel(ns, "public", "update", payload),
  ];
  if (isLocal) {
    tasks.push(broadcastToChannel(ns, "public:local", "update", payload));
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
 * Broadcasts to the "home:{actorId}" channel with event type "notification".
 * The payload is intentionally minimal — clients only need the event type.
 */
export async function broadcastNotificationEvent(
  ns: DONamespace,
  targetActorId: string,
): Promise<void> {
  await broadcastToChannel(ns, `home:${actorUsername(targetActorId)}`, "notification", "{}");
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
    }
  }
  await Promise.allSettled(tasks);
}
