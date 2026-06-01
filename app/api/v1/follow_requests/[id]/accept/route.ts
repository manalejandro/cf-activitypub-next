import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getFollow, updateFollowState, updateActor } from "@/lib/db";
import { buildAccept, buildFollow, generateId } from "@/lib/activitypub/utils";
import { deliverToInbox, fetchRemoteObject } from "@/lib/activitypub/federation";
import type { APActor } from "@/lib/types";

// POST /api/v1/follow_requests/:id/accept
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

  const requesterId = decodeURIComponent(id);
  const requester = await getActorById(env.DB, requesterId);
  if (!requester) return notFound("Account not found");

  const follow = await getFollow(env.DB, requester.id, actor.id);
  if (!follow || follow.state !== "pending") {
    return json({ id: requester.id, following: false, followed_by: false, requested: false }, 200);
  }

  await updateFollowState(env.DB, follow.id, "accepted");

  await updateActor(env.DB, actor.id, {
    followersCount: (actor.followersCount ?? 0) + 1,
  });
  await updateActor(env.DB, requester.id, {
    followingCount: (requester.followingCount ?? 0) + 1,
  });

  if (!actor.privateKeyPem) {
    return json({ id: requester.id, following: false, followed_by: true, requested: false }, 200);
  }

  const followActivity = buildFollow(baseUrl, requester.id, actor.id, follow.id);
  const acceptActivity = buildAccept(baseUrl, actor.id, { ...followActivity, id: follow.activityId ?? followActivity.id }, generateId());

  let requesterInbox = requester.inbox ?? null;
  if (!requesterInbox && !requester.isLocal) {
    const remoteActor = await fetchRemoteObject(requester.id) as APActor | null;
    requesterInbox = remoteActor?.inbox ?? null;
  }

  if (requesterInbox) {
    await deliverToInbox(requesterInbox, acceptActivity, `${actor.id}#main-key`, actor.privateKeyPem);
  }

  return json({ id: requester.id, following: false, followed_by: true, requested: false });
}
