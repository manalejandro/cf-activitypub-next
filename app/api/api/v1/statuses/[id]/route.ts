import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, deleteObject, updateActor, createLike, deleteLike, getLike, createAnnounce, deleteAnnounce, getAnnounce } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildDelete, buildLike, buildAnnounce, buildUndo, generateId, followersIRI } from "@/lib/activitypub/utils";
import { deliverToInboxes, collectFollowerInboxes, fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { APActor } from "@/lib/types";

// GET /api/v1/statuses/:id
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound("Author not found");

  return json(serializeStatus(obj, author, domain));
}

// DELETE /api/v1/statuses/:id
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");
  if (obj.actorId !== actor.id) return json({ error: "Forbidden" }, 403);

  const author = await getActorById(env.DB, obj.actorId);
  await deleteObject(env.DB, obj.id);
  await updateActor(env.DB, actor.id, { statusesCount: Math.max(0, actor.statusesCount - 1) });

  // Deliver Delete activity
  if (actor.privateKeyPem) {
    const deleteActivity = buildDelete(baseUrl, actor.id, obj.id, generateId());
    // Get IDs of actors who follow the current user (actor_id = follower, target_id = followed)
    const followers = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ actor_id: string }>();

    const followerIds = followers.results.map((r) => r.actor_id);
    const fetchActor = async (id: string): Promise<APActor | null> => {
      const cached = await getActorById(env.DB, id);
      return cached as unknown as APActor | null;
    };
    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    if (inboxes.length > 0) {
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(deleteActivity), actor.id);
    }
  }

  return json(serializeStatus(obj, author ?? actor, domain));
}
