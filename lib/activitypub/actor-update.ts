/**
 * Push the current actor document to the account's followers.
 *
 * Peers cache the actor document, so anything that changes how they treat the
 * account — a migration alias (`alsoKnownAs`), the `movedTo` redirect, a
 * profile edit — has to be delivered, not merely served on their next fetch
 * (Mastodon's `ActivityPub::UpdateDistributionWorker`). Without it the source
 * instance of a profile move keeps the stale document and rejects the Move
 * with "not an alias of this account".
 */

import type { D1Database, Queue } from "@cloudflare/workers-types";
import { buildActor, buildUpdateActor, generateId } from "@/lib/activitypub/utils";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { getActorFields, getActorById, getPreferredLicenseUrl } from "@/lib/db";
import type { APActor, LocalActor } from "@/lib/types";

export interface ActorUpdateEnv {
  DB: D1Database;
  DELIVERY_QUEUE?: Queue;
}

/** Deliver an `Update{Actor}` to every accepted follower; returns the inboxes queued. */
export async function broadcastActorUpdate(
  env: ActorUpdateEnv,
  actor: LocalActor,
  baseUrl: string
): Promise<number> {
  if (!actor.privateKeyPem) return 0;

  const fields = await getActorFields(env.DB, actor.id);
  const apActor = buildActor(baseUrl, actor.username, {
    displayName: actor.displayName ?? undefined,
    summary: actor.summary ?? undefined,
    avatarUrl: actor.avatarUrl,
    headerUrl: actor.headerUrl,
    publicKeyPem: actor.publicKeyPem,
    manuallyApprovesFollowers: actor.manuallyApprovesFollowers,
    discoverable: actor.discoverable,
    isBot: actor.isBot,
    followersCount: actor.followersCount,
    followingCount: actor.followingCount,
    statusesCount: actor.statusesCount,
    published: actor.createdAt,
    fields: fields.map((f) => ({ name: f.name, value: f.value })),
    alsoKnownAs: actor.alsoKnownAs ?? undefined,
    movedTo: actor.movedTo ?? undefined,
    preferredLicenseUrl: (await getPreferredLicenseUrl(env.DB, actor.id)) ?? undefined,
  });

  const updateActivity = buildUpdateActor(baseUrl, apActor, generateId());
  const followerRows = await env.DB
    .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
    .bind(actor.id)
    .all<{ actor_id: string }>();
  const fetchActor = async (id: string): Promise<APActor | null> =>
    (await getActorById(env.DB, id)) as unknown as APActor | null;
  const inboxes = await collectFollowerInboxes(followerRows.results.map((r) => r.actor_id), fetchActor);
  if (inboxes.length === 0) return 0;

  await enqueueDeliveries(
    env.DELIVERY_QUEUE,
    inboxes,
    JSON.stringify(updateActivity),
    actor.id,
    `${actor.id}#main-key`,
    actor.privateKeyPem
  );
  return inboxes.length;
}
