/**
 * Outbound account migration (Move) helpers.
 *
 * Mirrors Mastodon's AccountMigrationService:
 *  1. The local user names the target account (user@remote.instance).
 *  2. We resolve it via WebFinger and verify the target declares this account
 *     as an alias (alsoKnownAs), proving the user controls the target.
 *  3. We record the move (alsoKnownAs + movedTo) on the local actor.
 *  4. We send a Move activity to all followers. Local followers are migrated
 *     in place (their follow rows are re-pointed at the target); remote
 *     followers receive the Move and migrate on their own servers.
 */

import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { APActor, LocalActor } from "@/lib/types";
import { getActorById, getFollowers, createFollow, deleteFollow, updateActor } from "@/lib/db";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { resolveWebFinger } from "@/lib/activitypub/federation";
import { enqueueDeliveries, type APDeliveryMessage } from "@/lib/activitypub/queue";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { buildFollow, buildMove, generateId } from "@/lib/activitypub/utils";

export interface MoveVerification {
  ok: boolean;
  error?: string;
  target?: LocalActor;
}

/** Resolve a target acct and verify it aliases the local account. */
export async function verifyMoveTarget(
  db: D1Database,
  sourceId: string,
  targetAcct: string
): Promise<MoveVerification> {
  const acct = targetAcct.replace(/^@/, "").trim();
  if (!acct.includes("@")) {
    return { ok: false, error: "Invalid target account (expected user@domain)" };
  }

  const resolvedUrl = await resolveWebFinger(acct);
  if (!resolvedUrl) {
    return { ok: false, error: "Could not resolve target account via WebFinger" };
  }

  let target = await getActorById(db, resolvedUrl);
  if (!target) {
    const cached = await fetchAndCacheRemoteActor(db, resolvedUrl);
    if (!cached) {
      return { ok: false, error: "Could not fetch target account" };
    }
    target = await getActorById(db, cached.id);
  }
  if (!target) {
    return { ok: false, error: "Target account not found" };
  }

  if (target.id === sourceId) {
    return { ok: false, error: "Target account is the same as the current account" };
  }
  if (target.isLocal) {
    return { ok: false, error: "Cannot migrate to a local account" };
  }
  if (target.suspended) {
    return { ok: false, error: "Target account is suspended" };
  }
  if (target.movedTo) {
    return { ok: false, error: "Target account has already moved elsewhere" };
  }

  // Mastodon requires the target to list the source in its alsoKnownAs. A
  // cached copy may predate the alias (Mastodon pushes an Update{Actor} when it
  // is created, and some instances only refresh on the next fetch), so refresh
  // the actor once before refusing — that is the "wait up to 24 hours" the
  // Mastodon docs warn about.
  let aliases = target.alsoKnownAs ?? [];
  if (!aliases.includes(sourceId)) {
    const refreshed = await fetchAndCacheRemoteActor(db, resolvedUrl);
    if (refreshed) {
      const refetched = await getActorById(db, target.id);
      if (refetched) {
        target = refetched;
        aliases = refetched.alsoKnownAs ?? [];
      }
    }
  }
  if (!aliases.includes(sourceId)) {
    return {
      ok: false,
      error: "The target account does not list this account as an alias (alsoKnownAs). Add this account as an alias on the target first.",
    };
  }

  return { ok: true, target };
}

/** Inbox host, for counting the servers a delivery reached. */
function inboxDomain(inbox: string): string {
  try {
    return new URL(inbox).hostname.toLowerCase();
  } catch {
    return inbox;
  }
}

/** Perform the move: record it, migrate local followers, deliver Move to remote followers. */
export async function performMove(
  db: D1Database,
  baseUrl: string,
  source: LocalActor,
  target: LocalActor,
  queue?: Queue<APDeliveryMessage> | null,
  kv?: { delete(key: string): Promise<unknown> } | null
): Promise<{ migratedLocal: number; delivered: number }> {
  const sourceId = source.id;
  const targetId = target.id;

  // 1. Record the move on the source (alsoKnownAs + movedTo).
  const currentAliases = source.alsoKnownAs ?? [];
  await updateActor(db, sourceId, {
    alsoKnownAs: currentAliases.includes(targetId) ? currentAliases : [...currentAliases, targetId],
    movedTo: targetId,
  });

  // 2. Migrate local followers in place and re-follow the target for each one.
  // The target's instance only learns about a follower from a Follow signed by
  // that follower (Mastodon's MoveWorker does the same), otherwise the account
  // arrives at the new instance with no followers.
  const allFollowers = await getFollowers(db, sourceId, 10000, 0);
  let migratedLocal = 0;
  let acceptedMoved = 0;
  for (const follower of allFollowers) {
    if (!follower.isLocal) continue;
    const alreadyTargets = await db
      .prepare("SELECT id FROM follows WHERE actor_id = ? AND target_id = ? AND state = 'accepted'")
      .bind(follower.id, targetId)
      .first();
    await deleteFollow(db, follower.id, sourceId);
    if (!alreadyTargets) {
      // Build the Follow first so its id lands in `activity_id`: the target's
      // Accept{Follow} is matched by that column, and NULL left every migrated
      // follower stuck in `pending` on our side.
      const followActivity = buildFollow(baseUrl, follower.id, targetId, generateId());
      const state = target.manuallyApprovesFollowers ? "pending" : "accepted";
      await createFollow(db, {
        id: generateId(),
        actorId: follower.id,
        targetId,
        state,
        activityId: followActivity.id,
        createdAt: new Date().toISOString(),
      });
      if (state === "accepted") acceptedMoved++;
      if (target.inbox && follower.privateKeyPem) {
        await enqueueDeliveries(
          queue,
          [target.inbox],
          JSON.stringify(followActivity),
          follower.id,
          `${follower.id}#main-key`,
          follower.privateKeyPem
        ).catch(() => {});
      }
    }
    migratedLocal++;
  }
  // The source loses the followers that moved (the target counts its own).
  if (acceptedMoved > 0) {
    await db
      .prepare("UPDATE actors SET followers_count = MAX(COALESCE(followers_count, 0) - ?, 0) WHERE id = ?")
      .bind(acceptedMoved, sourceId)
      .run();
  }

  // 3. Deliver the Move to the remote followers (through the queue, shared
  // inboxes preferred) AND to the destination instance: setting up the alias
  // made it fetch and cache the old account, so without the Move it keeps
  // showing a followable profile with no "moved" notice until it happens to
  // refetch (Mastodon only tells the followers — `ProcessAccountService` reads
  // `movedTo`, but only on a re-resolve). `delivered` counts servers, i.e.
  // distinct inbox domains, which is what the UI reports.
  let delivered = 0;
  if (source.privateKeyPem) {
    const remoteIds = allFollowers.filter((f) => !f.isLocal).map((f) => f.id);
    const fetchActor = async (id: string): Promise<APActor | null> =>
      (await getActorById(db, id)) as unknown as APActor | null;
    const followerInboxes = await collectFollowerInboxes(remoteIds, fetchActor);
    const targets = [...new Set([...followerInboxes, ...(target.inbox ? [target.inbox] : [])])];
    if (targets.length > 0) {
      const moveActivity = buildMove(baseUrl, sourceId, targetId, generateId());
      await enqueueDeliveries(
        queue,
        targets,
        JSON.stringify(moveActivity),
        sourceId,
        `${sourceId}#main-key`,
        source.privateKeyPem
      );
      delivered = new Set(targets.map(inboxDomain)).size;
    }
  }

  // Drop the cached actor document (5-minute KV entry): a peer that refetches
  // right now must not get the pre-move copy.
  await kv?.delete(`ap:actor:${source.username.toLowerCase()}`).catch(() => {});

  return { migratedLocal, delivered };
}