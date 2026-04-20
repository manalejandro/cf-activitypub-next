import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import {
  getObjectById, getActorById, createAnnounce, getAnnounce,
  createObject, updateActor, createNotification,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { buildAnnounce, generateId, followersIRI } from "@/lib/activitypub/utils";
import { deliverToInboxes, collectFollowerInboxes } from "@/lib/activitypub/federation";
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

  const obj = await getObjectById(env.DB, decodeURIComponent(id));
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
      const followers = await env.DB
        .prepare("SELECT target_id FROM follows WHERE actor_id = ? AND state = 'accepted'")
        .bind(actor.id)
        .all<{ target_id: string }>();
      const followerIds = followers.results.map((r) => r.target_id);
      const fetchActor = async (id: string): Promise<APActor | null> => {
        const cached = await getActorById(env.DB, id);
        return cached as unknown as APActor | null;
      };
      const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
      if (inboxes.length > 0) {
        await deliverToInboxes(inboxes, announceActivity, `${actor.id}#main-key`, actor.privateKeyPem);
      }
    }
  }

  const refreshed = await getObjectById(env.DB, obj.id);
  return json(serializeStatus(refreshed ?? obj, author, domain, { reblogged: true }));
}
