import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, deleteLike, getLike } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildLike, buildUndo, generateId } from "@/lib/activitypub/utils";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { APActor } from "@/lib/types";

// POST /api/v1/statuses/:id/unfavourite
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

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound("Author not found");

  await deleteLike(env.DB, actor.id, obj.id);

  // Deliver Undo/Like to remote actor via queue
  if (!author.isLocal && actor.privateKeyPem) {
    const authorActor = await fetchRemoteObject(author.id) as APActor | null;
    const inbox = authorActor?.endpoints?.sharedInbox ?? authorActor?.inbox;
    if (inbox) {
      const like = buildLike(baseUrl, actor.id, obj.id, generateId());
      const undo = buildUndo(baseUrl, actor.id, like, generateId());
      await enqueueDeliveries(env.DELIVERY_QUEUE, [inbox], JSON.stringify(undo), actor.id);
    }
  }

  const refreshed = await getObjectById(env.DB, obj.id);
  return json(serializeStatus(refreshed ?? obj, author, domain, { favourited: false }));
}
