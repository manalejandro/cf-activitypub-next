import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getFollow, createFollow } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { buildFollow, generateId } from "@/lib/activitypub/utils";
import { deliverToInbox } from "@/lib/activitypub/federation";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { notify } from "@/lib/notify";
import { buildRelationship } from "@/lib/mastodon/relationships";

// POST /api/v1/accounts/:id/follow
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
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
  if (existing) {
    return json(await buildRelationship(env.DB, actor.id, target.id));
  }

  if (!actor.privateKeyPem) return json({ error: "Account has no private key" }, 500);

  const followId = generateId();
  const followActivity = buildFollow(baseUrl, actor.id, target.id, followId);

  await createFollow(env.DB, {
    id: followId,
    actorId: actor.id,
    targetId: target.id,
    state: target.manuallyApprovesFollowers ? "pending" : "accepted",
    activityId: followActivity.id,
    createdAt: new Date().toISOString(),
  });

  if (target.isLocal) {
    // Local follow — auto-accept if not locked
    if (!target.manuallyApprovesFollowers) {
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
      await deliverToInbox(inboxUrl, followActivity, `${actor.id}#main-key`, actor.privateKeyPem);
    } catch {
      // Delivery failure is non-fatal — follow is saved, will be retried or handled later
    }
    // Optimistically increment the local actor's following count (for non-locked remote accounts)
    if (!target.manuallyApprovesFollowers) {
      await env.DB.prepare("UPDATE actors SET following_count = COALESCE(following_count, 0) + 1 WHERE id = ?").bind(actor.id).run();
    }
  }

  return json(await buildRelationship(env.DB, actor.id, target.id));
}
