/**
 * ActivityPub relay subscriptions.
 *
 * A relay re-broadcasts the public statuses of its subscribers to every
 * instance subscribed to it. Subscribing follows Mastodon's `Relay`:
 *
 *   1. an admin adds the relay's inbox URL (row in `relays`, state `idle`);
 *   2. enabling sends `Follow{object: as:Public}` signed by the reserved
 *      instance actor and parks the row in `pending`;
 *   3. the relay answers `Accept{Follow}` (matched by `follow_activity_id`) to
 *      the instance actor's inbox → `accepted`, or `Reject{Follow}` →
 *      `rejected`;
 *   4. from then on its `Announce`s are stored as normal remote statuses
 *      (never as boosts), so relayed content lands in the federated timeline.
 *
 * Disabling sends `Undo{Follow}` and returns the row to `idle`; removing an
 * enabled relay disables it first so the relay stops pushing content.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { APDeliveryMessage } from "@/lib/activitypub/queue";
import type { LocalRelay } from "@/lib/types";
import { buildRelayFollow, buildUndo, generateId } from "@/lib/activitypub/utils";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { getInstanceSigner, validateOutboundUrl } from "@/lib/activitypub/federation";
import { getRelayById, listRelays, updateRelay } from "@/lib/db";

export interface RelayEnv {
  DB: D1Database;
  DELIVERY_QUEUE?: Queue<APDeliveryMessage> | null;
}

/**
 * Validate and normalize the inbox URL an admin types: https, public host,
 * no credentials, no fragment (the URL is the relay's identity in `relays`).
 */
export function normalizeRelayInbox(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!validateOutboundUrl(url.toString()).valid) return null;
  url.hash = "";
  return url.toString();
}

/** Host of a relay's inbox, for matching the actor that answers for it. */
export function relayHost(relay: LocalRelay): string {
  try {
    return new URL(relay.inboxUrl).hostname;
  } catch {
    return "";
  }
}

/** The relay that owns an answering actor: recorded actor URI, its inbox, or its host. */
export function relayMatchesActor(relay: LocalRelay, actor: { id: string; inbox?: string | null; sharedInbox?: string | null }): boolean {
  if (relay.actorUri && relay.actorUri === actor.id) return true;
  if (actor.inbox && actor.inbox === relay.inboxUrl) return true;
  if (actor.sharedInbox && actor.sharedInbox === relay.inboxUrl) return true;
  const host = relayHost(relay);
  if (!host) return false;
  try {
    return new URL(actor.id).hostname === host;
  } catch {
    return false;
  }
}

/**
 * The known relay an announcing actor belongs to, if any. Relays are few, so
 * the match runs in memory (actor URI, then inbox, then same host). A DB that
 * has not run the relays migration yet simply answers "no relay": an Announce
 * must keep working as a normal boost.
 */
export async function relayForActor(
  db: D1Database,
  actor: { id: string; inbox?: string | null; sharedInbox?: string | null }
): Promise<LocalRelay | null> {
  try {
    const relays = await listRelays(db);
    return relays.find((r) => relayMatchesActor(r, actor)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Inboxes of the relays this instance is subscribed to. A public status is
 * delivered there so the relay re-broadcasts it to every other subscriber
 * (Mastodon's `StatusReachFinder#relay_inboxes`). A DB without the relays
 * migration answers [] and delivery keeps working.
 */
export async function acceptedRelayInboxes(db: D1Database): Promise<string[]> {
  try {
    const rows = await db
      .prepare("SELECT inbox_url FROM relays WHERE state = 'accepted'")
      .bind()
      .all<{ inbox_url: string }>();
    return (rows.results ?? []).map((row) => row.inbox_url);
  } catch {
    return [];
  }
}

/**
 * Delivery targets for a local status: the given inboxes plus every subscribed
 * relay when the status is public (relays never receive unlisted/private/direct
 * posts). Relay delivery is what puts the post on the relay for its other
 * subscribers.
 */
export async function withRelayInboxes(
  db: D1Database,
  visibility: string,
  inboxes: string[]
): Promise<string[]> {
  if (visibility !== "public") return inboxes;
  return [...inboxes, ...(await acceptedRelayInboxes(db))];
}

/**
 * Subscribe: send the relay Follow signed by the reserved instance actor and
 * move the row to `pending`. Returns the updated relay (null when the instance
 * has no signing actor at all).
 */
export async function enableRelay(env: RelayEnv, relay: LocalRelay, baseUrl: string): Promise<LocalRelay | null> {
  const signer = await getInstanceSigner();
  if (!signer) return null;

  const follow = buildRelayFollow(baseUrl, signer.id, generateId());
  await updateRelay(env.DB, relay.id, { state: "pending", followActivityId: follow.id });
  await enqueueDeliveries(
    env.DELIVERY_QUEUE,
    [relay.inboxUrl],
    JSON.stringify(follow),
    signer.id,
    `${signer.id}#main-key`,
    signer.privateKeyPem
  );
  return getRelayById(env.DB, relay.id);
}

/**
 * Unsubscribe: send `Undo{Follow}` for the stored subscription and return the
 * row to `idle` (the relay keeps the row so it can be enabled again).
 */
export async function disableRelay(env: RelayEnv, relay: LocalRelay, baseUrl: string): Promise<LocalRelay | null> {
  // State first: the relay must stop being trusted even if the Undo delivery
  // fails (a failed Undo only leaves the relay pushing content we now ignore).
  const followActivityId = relay.followActivityId;
  await updateRelay(env.DB, relay.id, { state: "idle", followActivityId: null });

  const signer = await getInstanceSigner();
  if (signer && followActivityId) {
    const undo = buildUndo(
      baseUrl,
      signer.id,
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: followActivityId,
        type: "Follow",
        actor: signer.id,
        object: "https://www.w3.org/ns/activitystreams#Public",
      },
      generateId()
    );
    try {
      await enqueueDeliveries(
        env.DELIVERY_QUEUE,
        [relay.inboxUrl],
        JSON.stringify(undo),
        signer.id,
        `${signer.id}#main-key`,
        signer.privateKeyPem
      );
    } catch { /* best-effort: the relay is already untrusted */ }
  }
  return getRelayById(env.DB, relay.id);
}
