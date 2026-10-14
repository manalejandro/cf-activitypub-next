import { type NextRequest } from "next/server";
import { json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getFollow, createFollow } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { buildFollow, generateId } from "@/lib/activitypub/utils";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { notify } from "@/lib/notify";
import { buildRelationship } from "@/lib/mastodon/relationships";
import { env } from "cloudflare:workers";

// POST /api/v1/accounts/:id/follow
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const rawId = decodeURIComponent(id);
  let target = await getActorById(env.DB, rawId);
  let remoteInbox: string | null = null;

  // If not cached locally and looks like a URL, fetch and cache the remote actor
  if (!target && rawId.startsWith("https://")) {
    const cached = await fetchAndCacheRemoteActor(env.DB, rawId, env.KV);
    if (cached) {
      target = await getActorById(env.DB, cached.id);
      remoteInbox = cached.inbox;
    }
  } else if (target && !target.isLocal && !target.inbox) {
    // Actor is cached but inbox was never stored — refresh to get it
    const refreshed = await fetchAndCacheRemoteActor(env.DB, rawId, env.KV);
    if (refreshed) remoteInbox = refreshed.inbox;
  }

  if (!target) return notFound("Account not found");

  if (actor.id === target.id) {
    return json({ error: "Cannot follow yourself" }, 422);
  }

  const existing = await getFollow(env.DB, actor.id, target.id);
  if (existing && existing.state !== "rejected") {
    return json(await buildRelationship(env.DB, actor.id, target.id));
  }

  if (!actor.privateKeyPem) return json({ error: "Account has no private key" }, 500);

  // Mastodon's `FollowService`: a limited (silenced) account's follow is
  // converted into a follow request, even when the target does not require
  // approval — the target decides whether to accept it.
  const needsApproval = target.manuallyApprovesFollowers || actor.silenced === true;

  const followId = generateId();
  const followActivity = buildFollow(baseUrl, actor.id, target.id, followId);

  if (existing) {
    // Re-follow after a rejection: reuse the row with a fresh Follow activity
    // (the rejected activity id must not be replayed) and reset the state.
    await env.DB
      .prepare("UPDATE follows SET state = ?, activity_id = ?, created_at = ? WHERE id = ?")
      .bind(
        needsApproval ? "pending" : "accepted",
        followActivity.id,
        new Date().toISOString(),
        existing.id
      )
      .run();
  } else {
    await createFollow(env.DB, {
      id: followId,
      actorId: actor.id,
      targetId: target.id,
      state: needsApproval ? "pending" : "accepted",
      activityId: followActivity.id,
      createdAt: new Date().toISOString(),
    });
  }

  if (target.isLocal) {
    // Local follow — auto-accept unless the target is locked or the follower is
    // limited (its follow becomes a request either way).
    if (!needsApproval) {
      await env.DB.prepare("UPDATE actors SET following_count = COALESCE(following_count, 0) + 1 WHERE id = ?").bind(actor.id).run();
      await env.DB.prepare("UPDATE actors SET followers_count = COALESCE(followers_count, 0) + 1 WHERE id = ?").bind(target.id).run();
      await notify(env, {
        id: generateId(),
        type: "follow",
        accountId: actor.id,
        targetAccountId: target.id,
        objectId: null,
        read: false,
        createdAt: new Date().toISOString(),
      });
    } else {
      await notify(env, {
        id: generateId(),
        type: "follow_request",
        accountId: actor.id,
        targetAccountId: target.id,
        objectId: null,
        read: false,
        createdAt: new Date().toISOString(),
      });
    }
  } else {
    // Remote follow — deliver Follow activity to the stored inbox URL
    const inboxUrl = remoteInbox ?? target.inbox ?? `${target.id}/inbox`;
    try {
      await enqueueDeliveries(env.DELIVERY_QUEUE, [inboxUrl], JSON.stringify(followActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
    } catch {
      // Delivery failure is non-fatal — follow is saved, will be retried or handled later
    }
    // Optimistically increment the local actor's following count (accepted
    // follows only; a request stays pending until the remote accepts).
    if (!needsApproval) {
      await env.DB.prepare("UPDATE actors SET following_count = COALESCE(following_count, 0) + 1 WHERE id = ?").bind(actor.id).run();
    }
  }

  return json(await buildRelationship(env.DB, actor.id, target.id));
}
