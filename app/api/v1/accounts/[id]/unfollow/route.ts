import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getFollow, deleteFollow } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { buildUndo, buildFollow, generateId } from "@/lib/activitypub/utils";
import { deliverToInbox } from "@/lib/activitypub/federation";
import { buildRelationship } from "@/lib/mastodon/relationships";

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
    return json(await buildRelationship(env.DB, actor.id, target.id));
  }

  await deleteFollow(env.DB, actor.id, target.id);

  if (follow.state === "accepted") {
    await env.DB.prepare("UPDATE actors SET following_count = MAX(COALESCE(following_count, 0) - 1, 0) WHERE id = ?").bind(actor.id).run();
    await env.DB.prepare("UPDATE actors SET followers_count = MAX(COALESCE(followers_count, 0) - 1, 0) WHERE id = ?").bind(target.id).run();
  }

  if (!target.isLocal && actor.privateKeyPem && follow.activityId) {
    const undoId = generateId();
    const originalFollow = buildFollow(baseUrl, actor.id, target.id, follow.id);
    const undoActivity = buildUndo(baseUrl, actor.id, { ...originalFollow, id: follow.activityId }, undoId);
    const inboxUrl = (target as unknown as Record<string, string>).inbox ?? `${target.id}/inbox`;
    await deliverToInbox(inboxUrl, undoActivity, `${actor.id}#main-key`, actor.privateKeyPem);
  }

  return json(await buildRelationship(env.DB, actor.id, target.id));
}
