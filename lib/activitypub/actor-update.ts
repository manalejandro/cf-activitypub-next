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
import { getBaseUrl } from "@/lib/cf";
import { buildActor, buildUpdateActor, generateId } from "@/lib/activitypub/utils";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { getActorFields, getActorById, getPreferredLicenseUrl } from "@/lib/db";
import type { APActor, LocalActor } from "@/lib/types";

export interface ActorUpdateEnv {
  DB: D1Database;
  DELIVERY_QUEUE?: Queue;
  INSTANCE_URL?: string;
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
    // The pushed document must match what the actor route serves: without these
    // a broadcast from a suspended (or memorialized) account told peers it was
    // active again.
    suspended: actor.suspended === true,
    memorial: actor.memorial === true,
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

/**
 * Push the actor's current document to its followers after a suspension (or an
 * unsuspension). Peers cache the document and only re-read it on a refetch, and
 * a suspended account never posts again to trigger one — Mastodon does the same
 * in `SuspendAccountService#distribute_update_actor`, which is what actually
 * disconnects the account from the fediverse: every follower marks it suspended
 * and drops its content.
 */
export async function broadcastActorState(env: ActorUpdateEnv, actorId: string): Promise<number> {
  const actor = await getActorById(env.DB, actorId);
  if (!actor?.isLocal) return 0;
  return broadcastActorUpdate(env, actor, getBaseUrl(env as unknown as Parameters<typeof getBaseUrl>[0]));
}
