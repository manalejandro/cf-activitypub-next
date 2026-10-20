/**
 * Featured items on a profile: pinned statuses (`status_pins`) and featured
 * hashtags (`featured_tags`).
 *
 * Mastodon federates both: pinning a status or featuring a tag sends an
 * `Add` (and unpinning a `Remove`) whose `target` is the actor's featured
 * collection (`ActivityPub::RawDistributionWorker` / `AccountRawDistributionWorker`,
 * via `ActivityPub::AddSerializer`/`RemoveSerializer`). The activity goes to the
 * **followers** — the collection itself is public and peers fetch it on demand
 * (`fetchAndCacheRemoteActorFeatured` on our side). The profile "recommend"
 * (Mastodon's `AccountPin`, `POST /api/v1/accounts/:id/pin`) is deliberately
 * **not** federated: Mastodon keeps it local.
 *
 * Delivery always goes through the queue (`enqueueDeliveries`), like every other
 * outbound activity.
 */

import { getActorById } from "@/lib/db";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { buildFeaturedActivity, type APFeaturedTagObject } from "@/lib/activitypub/utils";
import type { APActor, LocalActor } from "@/lib/types";

export interface FeaturedDeliveryEnv {
  DB: D1Database;
  DELIVERY_QUEUE?: Queue;
}

/** The `object` of an `Add`/`Remove` for a featured hashtag. */
export function featuredTagObject(baseUrl: string, tagName: string): APFeaturedTagObject {
  return { type: "Hashtag", href: `${baseUrl}/tags/${tagName}`, name: `#${tagName}` };
}

/**
 * Send an `Add`/`Remove` for one of the actor's featured items to every accepted
 * follower. Fire-and-forget like the other federation side effects: a delivery
 * problem must never fail the request that pinned the item.
 */
export async function deliverFeaturedChange(
  env: FeaturedDeliveryEnv,
  actor: LocalActor,
  object: string | APFeaturedTagObject,
  type: "Add" | "Remove",
  collection: "featured" | "tags" = "featured"
): Promise<void> {
  if (!env.DELIVERY_QUEUE || !actor.privateKeyPem) return;
  try {
    const followers = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ actor_id: string }>();
    const followerIds = (followers.results ?? []).map((row) => row.actor_id);
    if (followerIds.length === 0) return;

    const fetchActor = async (id: string): Promise<APActor | null> =>
      (await getActorById(env.DB, id)) as unknown as APActor | null;
    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    if (inboxes.length === 0) return;

    await enqueueDeliveries(
      env.DELIVERY_QUEUE,
      inboxes,
      JSON.stringify(buildFeaturedActivity(type, actor.id, object, collection)),
      actor.id,
      `${actor.id}#main-key`,
      actor.privateKeyPem
    );
  } catch (err) {
    console.error(`[featured] ${type} delivery failed`, err);
  }
}
