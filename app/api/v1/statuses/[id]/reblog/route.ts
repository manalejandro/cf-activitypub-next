import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import {
  getObjectById, getActorById, createAnnounce, getAnnounce,
  createObject, updateActor, createNotification,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildAnnounce, generateId, followersIRI } from "@/lib/activitypub/utils";
import { collectFollowerInboxes, fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { APActor } from "@/lib/types";

// POST /api/v1/statuses/:id/reblog
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

  const existing = await getAnnounce(env.DB, actor.id, obj.id);
  if (!existing) {
    const announceId = generateId();
    const announceActivity = buildAnnounce(baseUrl, actor.id, obj.id, announceId, `${baseUrl}/users/${actor.username}/followers`);

    await createAnnounce(env.DB, {
      id: announceId,
      actorId: actor.id,
      objectId: obj.id,
      activityId: announceActivity.id,
      createdAt: new Date().toISOString(),
    });

    if (author.id !== actor.id) {
      await createNotification(env.DB, {
        id: generateId(),
        type: "reblog",
        accountId: actor.id,
        targetAccountId: author.id,
        objectId: obj.id,
        read: false,
        createdAt: new Date().toISOString(),
      });
    }

    if (actor.privateKeyPem) {
      const inboxes: string[] = [];

      // 1. Deliver to our followers
      const followers = await env.DB
        .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
        .bind(actor.id)
        .all<{ actor_id: string }>();
      const followerIds = followers.results.map((r) => r.actor_id);
      const fetchActor = async (id: string): Promise<APActor | null> => {
        const cached = await getActorById(env.DB, id);
        return cached as unknown as APActor | null;
      };
      inboxes.push(...await collectFollowerInboxes(followerIds, fetchActor));

      // 2. Deliver to the remote post author (so they can increment reblog count)
      if (!author.isLocal) {
        const authorActor = await fetchRemoteObject(author.id) as APActor | null;
        const authorInbox = authorActor?.endpoints?.sharedInbox ?? authorActor?.inbox;
        if (authorInbox) inboxes.push(authorInbox);
      }

      if (inboxes.length > 0) {
        await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(announceActivity), actor.id);
      }
    }
  }

  const refreshed = await getObjectById(env.DB, obj.id);
  return json(serializeStatus(refreshed ?? obj, author, domain, { reblogged: true }));
}
