import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, createLike, getLike, createNotification } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { buildLike, generateId } from "@/lib/activitypub/utils";
import { deliverToInbox, fetchRemoteObject } from "@/lib/activitypub/federation";
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

  const obj = await getObjectById(env.DB, decodeURIComponent(id));
  if (!obj) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound("Author not found");

  const existing = await getLike(env.DB, actor.id, obj.id);
  if (!existing) {
    const likeId = generateId();
    const likeActivity = buildLike(baseUrl, actor.id, obj.id, likeId);

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

    // Deliver Like to remote actor
    if (!author.isLocal && actor.privateKeyPem) {
      const authorActor = await fetchRemoteObject(author.id) as APActor | null;
      const inbox = authorActor?.inbox ?? `${author.id}/inbox`;
      await deliverToInbox(inbox, likeActivity, `${actor.id}#main-key`, actor.privateKeyPem);
    }
  }

  const refreshed = await getObjectById(env.DB, obj.id);
  return json(serializeStatus(refreshed ?? obj, author, domain, { favourited: true }));
}
