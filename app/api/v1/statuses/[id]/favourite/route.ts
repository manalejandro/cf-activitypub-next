import { type NextRequest } from "next/server";
import { json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, createLike, getLike, isAcceptedFollower, canViewStatus } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatusForStream, loadViewerStatusState } from "@/lib/streaming/serialize";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildLike, generateId, followersIRI } from "@/lib/activitypub/utils";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { notify } from "@/lib/notify";
import { broadcastStatusInteraction, broadcastStatusInteractionToLists } from "@/lib/streaming/broadcast";
import type { APActor } from "@/lib/types";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";
import { env } from "cloudflare:workers";

// POST /api/v1/statuses/:id/favourite
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
      await notify(env, {
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
        await enqueueDeliveries(env.DELIVERY_QUEUE, [inbox], JSON.stringify(likeActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
      }
    }
  }

  const refreshed = await getObjectById(env.DB, obj.id);
  const target = refreshed ?? obj;
  const [authorExtras, viewerState] = await Promise.all([
    getStatusAuthorExtras(env.DB, [obj.actorId], domain).then((m) => m.get(obj.actorId)),
    loadViewerStatusState(env.DB, actor.id, target),
  ]);
  const serialized = await serializeStatusForStream(env.DB, target, author, domain, {
    ...viewerState,
    viewerId: actor.id,
    favourited: true,
    authorSupportsCalls: authorExtras?.supportsCalls,
    authorMoved: authorExtras?.moved ?? null,
  });
  // Live counters: refresh the status in every subscribed timeline.
  if (env.TIMELINE_STREAM) await broadcastStatusInteraction(env.TIMELINE_STREAM, serialized, author);
  if (env.TIMELINE_STREAM) await broadcastStatusInteractionToLists(env.DB, env.TIMELINE_STREAM, author.id, serialized);
  return json(serialized);
}