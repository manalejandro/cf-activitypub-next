import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, getActorStatuses, getActorStatuses_withReplies, getAttachmentsByObjectIds, getPollsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds, getAllCustomEmojis, getFollow, rowToObject, getReplyToAccountIdMap, getObjectQuotesCounts } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { getQuotesByIds } from "@/lib/mastodon/quote";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { fetchAndCacheRemoteActorStatuses, fetchAndCacheRemoteActorFeatured } from "@/lib/activitypub/remote";
import { DEFAULT_TIMELINE_PAGE, MAX_PAGE_SIZE } from "@/lib/constants";

// GET /api/v1/accounts/:id/statuses
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? String(DEFAULT_TIMELINE_PAGE)), MAX_PAGE_SIZE);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const onlyReplies = searchParams.get("only_replies") === "true";
  const pinnedOnly = searchParams.get("pinned") === "true";

  const actor = await getActorById(env.DB, decodeURIComponent(id));
  if (!actor) return notFound("Account not found");

  const me = await getAuthenticatedActor(request, env.DB);
  const isFollowing = me ? !!(await getFollow(env.DB, me.id, actor.id)) : false;

  // Remote accounts whose statuses were never federated here have nothing in
  // `objects`. On the first page of a remote profile, poll the actor's outbox
  // and ingest the visible statuses so the timeline isn't empty.
  if (!actor.isLocal && !pinnedOnly && !onlyReplies && !maxId) {
    await fetchAndCacheRemoteActorStatuses(env.DB, actor.id, limit);
  }

  // Remote pinned posts come from the actor's `featured` collection, not the
  // local status_pins table — ingest them so the pinned tab shows content.
  if (pinnedOnly && !actor.isLocal) {
    await fetchAndCacheRemoteActorFeatured(env.DB, actor.id);
  }

  // Fetch pinned statuses from status_pins table
  let pinnedSet = new Set<string>();
  if (pinnedOnly) {
    const pinRows = await env.DB
      .prepare(
        `SELECT sp.status_id FROM status_pins sp
         JOIN objects o ON o.id = sp.status_id
         WHERE sp.actor_id = ?
         ORDER BY sp.created_at DESC
         LIMIT ?`
      )
      .bind(actor.id, limit)
      .all<{ status_id: string }>();
    pinnedSet = new Set(pinRows.results.map((r) => r.status_id));
  }

  const objects = pinnedOnly
    ? []
    : onlyReplies
      ? await getActorStatuses_withReplies(env.DB, actor.id, limit, maxId, me?.id, isFollowing)
      : await getActorStatuses(env.DB, actor.id, limit, maxId, me?.id, isFollowing);

  // If pinnedOnly, fetch objects by the status IDs we got from status_pins
  let allObjects = objects;
  if (pinnedOnly && pinnedSet.size > 0) {
    const placeholders = [...pinnedSet].map(() => "?").join(",");
    const rowObjs = await env.DB
      .prepare(`SELECT * FROM objects WHERE id IN (${placeholders})`)
      .bind(...[...pinnedSet])
      .all<Record<string, unknown>>();
    allObjects = rowObjs.results.map(rowToObject);
  }

  const [attachmentMap, pollMap, likedIds, announcedIds, allEmojis, replyToMap, quotesCountMap, quotesById] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, allObjects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, allObjects.map((o) => o.id)),
    me ? getLikedObjectIds(env.DB, me.id, allObjects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    me ? getAnnouncedObjectIds(env.DB, me.id, allObjects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    getAllCustomEmojis(env.DB),
    getReplyToAccountIdMap(env.DB, allObjects),
    getObjectQuotesCounts(env.DB, allObjects.map((o) => o.id)),
    getQuotesByIds(env.DB, allObjects.map((o) => o.quoteId).filter(Boolean) as string[], domain),
  ]);

  const statuses = allObjects.map((obj) => {
    const pollEntry = pollMap.get(obj.id);
    const poll = pollEntry ? serializePoll(pollEntry.poll, pollEntry.options, false, []) : null;
    return serializeStatus(obj, actor, domain, {
      attachments: attachmentMap.get(obj.id) ?? [],
      poll,
      favourited: likedIds.has(obj.id),
      reblogged: announcedIds.has(obj.id),
      emojis: allEmojis,
      pinned: pinnedOnly || pinnedSet.has(obj.id),
      inReplyToAccountId: replyToMap.get(obj.id) ?? null,
      quote: obj.quoteId ? (quotesById.get(obj.quoteId) ?? null) : null,
      quotesCount: quotesCountMap.get(obj.id) ?? 0,
    });
  });

  const response = json(statuses);
  if (statuses.length > 0) {
    const oldest = statuses[statuses.length - 1] as { id: string };
    response.headers.set("Link", buildPaginationLinks(request, oldest.id));
  }
  return response;
}
