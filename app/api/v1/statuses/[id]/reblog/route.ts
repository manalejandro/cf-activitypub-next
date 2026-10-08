import { type NextRequest } from "next/server";
import { json, notFound, unauthorized } from "@/lib/cf";
import {
  getObjectById, getActorById, createAnnounce, getAnnounce,
  isAcceptedFollower, canViewStatus,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatusForStream, loadViewerStatusState } from "@/lib/streaming/serialize";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildAnnounce, generateId } from "@/lib/activitypub/utils";
import { collectFollowerInboxes, fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { notify } from "@/lib/notify";
import { broadcastStatusInteraction, broadcastStatusInteractionToLists } from "@/lib/streaming/broadcast";
import { broadcastNewBoostToFollowers } from "@/lib/streaming/boost";
import type { APActor } from "@/lib/types";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";
import { env } from "cloudflare:workers";

// POST /api/v1/statuses/:id/reblog
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound("Author not found");

  const isFollowing = await isAcceptedFollower(env.DB, actor.id, obj.actorId);
  if (!canViewStatus(obj, actor.id, isFollowing)) {
    return notFound("Record not found");
  }

  const existing = await getAnnounce(env.DB, actor.id, obj.id);
  let announceId: string | null = null;
  let announceCreatedAt = "";
  if (!existing) {
    announceId = generateId();
    announceCreatedAt = new Date().toISOString();
    const announceActivity = buildAnnounce(baseUrl, actor.id, obj.id, announceId, `${baseUrl}/users/${actor.username}/followers`);

    await createAnnounce(env.DB, {
      id: announceId,
      actorId: actor.id,
      objectId: obj.id,
      activityId: announceActivity.id,
      createdAt: announceCreatedAt,
    });

    if (author.id !== actor.id) {
      await notify(env, {
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
        await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(announceActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
      }
    }
  }

  const refreshed = await getObjectById(env.DB, obj.id);
  const target = refreshed ?? obj;
  const [authorExtras, viewerState] = await Promise.all([
    getStatusAuthorExtras(env.DB, [obj.actorId], domain).then((m) => m.get(obj.actorId)),
    loadViewerStatusState(env.DB, actor.id, target),
  ]);
  // The response replaces the boosted entry in the timeline: it must carry the
  // full status (media, poll with the viewer's votes, quote…), or the merge
  // would drop them.
  const serialized = await serializeStatusForStream(env.DB, target, author, domain, {
    ...viewerState,
    viewerId: actor.id,
    reblogged: true,
    authorSupportsCalls: authorExtras?.supportsCalls,
    authorMoved: authorExtras?.moved ?? null,
  });
  if (env.TIMELINE_STREAM) await broadcastStatusInteraction(env.TIMELINE_STREAM, serialized, author);
  if (env.TIMELINE_STREAM) await broadcastStatusInteractionToLists(env.DB, env.TIMELINE_STREAM, author.id, serialized);
  // Live boost for the booster's local followers (mirrors handleAnnounce):
  // without it the wrapper only appeared on the next timeline reload.
  if (announceId) {
    await broadcastNewBoostToFollowers(env.DB, env.TIMELINE_STREAM, actor, refreshed ?? obj, announceId, announceCreatedAt, domain);
  }
  return json(serialized);
}