import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, createLike, getLike, createNotification } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildLike, generateId, followersIRI } from "@/lib/activitypub/utils";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { APActor } from "@/lib/types";

// POST /api/v1/statuses/:id/favourite
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

  const existing = await getLike(env.DB, actor.id, obj.id);
  if (!existing) {
    const likeId = generateId();
    const likeActivity = buildLike(baseUrl, actor.id, obj.id, likeId, followersIRI(baseUrl, actor.username));

    await createLike(env.DB, {
      id: likeId,
      actorId: actor.id,
      objectId: obj.id,
      activityId: likeActivity.id,
      createdAt: new Date().toISOString(),
    });

    if (author.id !== actor.id) {
      await createNotification(env.DB, {
        id: generateId(),
        type: "favourite",
        accountId: actor.id,
        targetAccountId: author.id,
        objectId: obj.id,
        read: false,
        createdAt: new Date().toISOString(),
      });
    }

    // Deliver Like to remote actor via queue
    if (!author.isLocal && actor.privateKeyPem) {
      const authorActor = await fetchRemoteObject(author.id) as APActor | null;
      const inbox = authorActor?.endpoints?.sharedInbox ?? authorActor?.inbox;
      if (inbox) {
        await enqueueDeliveries(env.DELIVERY_QUEUE, [inbox], JSON.stringify(likeActivity), actor.id);
      }
    }
  }

  const refreshed = await getObjectById(env.DB, obj.id);
  return json(serializeStatus(refreshed ?? obj, author, domain, { favourited: true }));
}
