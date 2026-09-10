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
import type { LocalActor } from "@/lib/types";
import { getActorById, getFollowers, createFollow, deleteFollow, updateActor } from "@/lib/db";
import { resolveWebFinger } from "@/lib/activitypub/federation";
import { enqueueDeliveries, type APDeliveryMessage } from "@/lib/activitypub/queue";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { buildMove, generateId } from "@/lib/activitypub/utils";

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

  // Mastodon requires the target to list the source in its alsoKnownAs.
  const aliases = target.alsoKnownAs ?? [];
  if (!aliases.includes(sourceId)) {
    return {
      ok: false,
      error: "The target account does not list this account as an alias (alsoKnownAs). Add this account as an alias on the target first.",
    };
  }

  return { ok: true, target };
}

/** Perform the move: record it, migrate local followers, deliver Move to remote followers. */
export async function performMove(
  db: D1Database,
  baseUrl: string,
  source: LocalActor,
  target: LocalActor,
  queue?: Queue<APDeliveryMessage> | null
): Promise<{ migratedLocal: number; delivered: number }> {
  const sourceId = source.id;
  const targetId = target.id;

  // 1. Record the move on the source (alsoKnownAs + movedTo).
  const currentAliases = source.alsoKnownAs ?? [];
  await updateActor(db, sourceId, {
    alsoKnownAs: currentAliases.includes(targetId) ? currentAliases : [...currentAliases, targetId],
    movedTo: targetId,
  });

  // 2. Migrate local followers in place.
  const allFollowers = await getFollowers(db, sourceId, 10000, 0);
  let migratedLocal = 0;
  for (const follower of allFollowers) {
    if (!follower.isLocal) continue;
    const alreadyTargets = await db
      .prepare("SELECT id FROM follows WHERE actor_id = ? AND target_id = ? AND state = 'accepted'")
      .bind(follower.id, targetId)
      .first();
    await deleteFollow(db, follower.id, sourceId);
    if (!alreadyTargets) {
      await createFollow(db, {
        id: generateId(),
        actorId: follower.id,
        targetId,
        state: target.manuallyApprovesFollowers ? "pending" : "accepted",
        activityId: null,
        createdAt: new Date().toISOString(),
      });
    }
    migratedLocal++;
  }

  // 3. Deliver Move to remote followers' inboxes (through the delivery queue).
  let delivered = 0;
  if (source.privateKeyPem) {
    const remoteInboxes = allFollowers
      .filter((f) => !f.isLocal && f.inbox)
      .map((f) => f.inbox!);
    const inboxes = [...new Set(remoteInboxes)];
    if (inboxes.length > 0) {
      const moveActivity = buildMove(baseUrl, sourceId, targetId, generateId(), inboxes);
      await enqueueDeliveries(
        queue,
        inboxes,
        JSON.stringify(moveActivity),
        sourceId,
        `${sourceId}#main-key`,
        source.privateKeyPem
      );
      delivered = inboxes.length;
    }
  }

  return { migratedLocal, delivered };
}