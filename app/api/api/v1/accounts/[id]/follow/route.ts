import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getFollow, createFollow, deleteFollow, updateActor } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { buildFollow, buildUndo, generateId, actorIRI, followersIRI } from "@/lib/activitypub/utils";
import { deliverToInbox } from "@/lib/activitypub/federation";
import type { APActivity } from "@/lib/types";

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

  const target = await getActorById(env.DB, decodeURIComponent(id));
  if (!target) return notFound("Account not found");

  if (actor.id === target.id) {
    return json({ error: "Cannot follow yourself" }, 422);
  }

  const existing = await getFollow(env.DB, actor.id, target.id);
  if (existing) {
    return json({ id: target.id, following: existing.state === "accepted", requested: existing.state === "pending" });
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
      await updateActor(env.DB, actor.id, { followingCount: actor.followingCount + 1 });
      await updateActor(env.DB, target.id, { followersCount: target.followersCount + 1 });
    }
  } else {
    // Remote follow — deliver Follow activity
    const inboxUrl = (target as unknown as Record<string, string>).inbox ?? `${target.id}/inbox`;
    await deliverToInbox(inboxUrl, followActivity, `${actor.id}#main-key`, actor.privateKeyPem);
  }

  return json({
    id: target.id,
    following: !target.manuallyApprovesFollowers,
    requested: target.manuallyApprovesFollowers,
    followed_by: false,
    blocking: false,
    muting: false,
    domain_blocking: false,
    notifying: false,
    endorsed: false,
  });
}
