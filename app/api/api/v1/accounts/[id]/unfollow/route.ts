import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getFollow, deleteFollow, updateActor } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { buildUndo, buildFollow, generateId } from "@/lib/activitypub/utils";
import { deliverToInbox } from "@/lib/activitypub/federation";

// POST /api/v1/accounts/:id/unfollow
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

  const follow = await getFollow(env.DB, actor.id, target.id);
  if (!follow) {
    return json({ id: target.id, following: false, requested: false });
  }

  await deleteFollow(env.DB, actor.id, target.id);

  if (follow.state === "accepted") {
    await updateActor(env.DB, actor.id, { followingCount: Math.max(0, actor.followingCount - 1) });
    await updateActor(env.DB, target.id, { followersCount: Math.max(0, target.followersCount - 1) });
  }

  if (!target.isLocal && actor.privateKeyPem && follow.activityId) {
    const undoId = generateId();
    const originalFollow = buildFollow(baseUrl, actor.id, target.id, follow.id);
    const undoActivity = buildUndo(baseUrl, actor.id, { ...originalFollow, id: follow.activityId }, undoId);
    const inboxUrl = (target as unknown as Record<string, string>).inbox ?? `${target.id}/inbox`;
    await deliverToInbox(inboxUrl, undoActivity, `${actor.id}#main-key`, actor.privateKeyPem);
  }

  return json({ id: target.id, following: false, requested: false });
}
