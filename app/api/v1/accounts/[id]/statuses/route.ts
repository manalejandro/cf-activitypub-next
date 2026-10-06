import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getActorsByIds, getActorStatuses, getActorStatuses_withReplies, getActorBoosts, getAttachmentsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds, getAllCustomEmojis, isAcceptedFollower, canViewStatus, rowToObject, getReplyToAccountIdMap, getObjectQuotesCounts, getLastStatusAtMap , getBookmarkedObjectIds, getMutedActorIds, getActorFieldsMap } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializeReblog, loadSerializedPolls } from "@/lib/mastodon/serializers";
import { getQuotesByIds } from "@/lib/mastodon/quote";
import { decodeStatusId, encodeStatusId } from "@/lib/mastodon/statusId";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { fetchAndCacheRemoteActorStatuses, fetchAndCacheRemoteActorFeatured } from "@/lib/activitypub/remote";
import { resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

// GET /api/v1/accounts/:id/statuses
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const onlyReplies = searchParams.get("only_replies") === "true";
  const onlyReblogs = searchParams.get("only_reblogs") === "true";
  const pinnedOnly = searchParams.get("pinned") === "true";

  const actor = await getActorById(env.DB, decodeURIComponent(id));
  if (!actor) return notFound("Account not found");

  const me = await getAuthenticatedActor(request, env.DB);
  // Remote profiles (and their on-demand outbox fetch) are authenticated-only.
  if (!actor.isLocal && !me) return unauthorized();
  const isFollowing = me ? await isAcceptedFollower(env.DB, me.id, actor.id) : false;

  // Remote accounts whose statuses were never federated here have nothing in
  // `objects`. On the first page of a remote profile, poll the actor's outbox
  // and ingest the visible statuses so the timeline isn't empty (not for the
  // boosts tab: those come from the announces we already have).
  if (!actor.isLocal && !pinnedOnly && !onlyReplies && !onlyReblogs && !maxId) {
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

  const excludeReblogs = searchParams.get("exclude_reblogs") === "true";
  const entries = pinnedOnly
    ? []
    : onlyReplies
      ? await getActorStatuses_withReplies(env.DB, actor.id, limit, maxId, me?.id, isFollowing)
      : onlyReblogs
        ? await getActorBoosts(env.DB, actor.id, limit, maxId, me?.id, isFollowing)
        : await getActorStatuses(env.DB, actor.id, limit, maxId, me?.id, isFollowing, { includeBoosts: !excludeReblogs });

  // If pinnedOnly, fetch objects by the status IDs we got from status_pins
  let allEntries = entries;
  if (pinnedOnly && pinnedSet.size > 0) {
    const placeholders = [...pinnedSet].map(() => "?").join(",");
    const rowObjs = await env.DB
      .prepare(`SELECT * FROM objects WHERE id IN (${placeholders})`)
      .bind(...[...pinnedSet])
      .all<Record<string, unknown>>();
    // Pinned statuses obey the same visibility rules as any other status:
    // a direct/private pin must never leak to anonymous or non-followers.
    allEntries = rowObjs.results
      .map(rowToObject)
      .filter((o) => canViewStatus(o, me?.id ?? null, isFollowing))
      .map((object) => ({ object, boost: null }));
  }
  const allObjects = allEntries.map((entry) => entry.object);

  const [attachmentMap, pollMap, likedIds, announcedIds, allEmojis, replyToMap, quotesCountMap, quotesById, filteredMap, lastStatusAtMap, bookmarkedIds, mutedIds] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, allObjects.map((o) => o.id)),
    loadSerializedPolls(env.DB, me?.id ?? null, allObjects.map((o) => o.id)),
    me ? getLikedObjectIds(env.DB, me.id, allObjects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    me ? getAnnouncedObjectIds(env.DB, me.id, allObjects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    getAllCustomEmojis(env.DB),
    getReplyToAccountIdMap(env.DB, allObjects),
    getObjectQuotesCounts(env.DB, allObjects.map((o) => o.id)),
    getQuotesByIds(env.DB, allObjects.map((o) => o.quoteId).filter(Boolean) as string[], domain, me?.id ?? null),
    me ? getFilterResultsForStatuses(env.DB, me.id, allObjects) : Promise.resolve(new Map()),
    getLastStatusAtMap(env.DB, allObjects.map((o) => o.actorId)),
    me ? getBookmarkedObjectIds(env.DB, me.id, allObjects.map((o) => o.id)) : Promise.resolve(new Set()),
    me ? getMutedActorIds(env.DB, me.id).then((ids) => new Set(ids)) : Promise.resolve(new Set()),
  ]);

  const authorExtras = await getStatusAuthorExtras(env.DB, allObjects.map((o) => o.actorId), domain);
  const authorFieldsMap = await getActorFieldsMap(env.DB, allObjects.map((o) => o.actorId));

  // A boosted object belongs to its original author, not to the profile being
  // viewed: resolve every distinct author so the inner card shows the right
  // account (and the wrapper keeps the profile account as the booster).
  const authorMap = await getActorsByIds(env.DB, [...new Set(allObjects.map((o) => o.actorId))]);
  if (!authorMap.has(actor.id)) authorMap.set(actor.id, actor);

  const statuses = allEntries.map((entry) => {
    const obj = entry.object;
    const author = authorMap.get(obj.actorId);
    if (!author) return null;
    const poll = pollMap.get(obj.id) ?? null;
    const serialized = serializeStatus(obj, author, domain, {
      attachments: attachmentMap.get(obj.id) ?? [],
      poll,
      favourited: likedIds.has(obj.id),
      reblogged: announcedIds.has(obj.id),
      emojis: allEmojis,
      pinned: pinnedOnly || pinnedSet.has(obj.id),
      inReplyToAccountId: replyToMap.get(obj.id) ?? null,
      quote: obj.quoteId ? (quotesById.get(obj.quoteId) ?? null) : null,
      quotesCount: quotesCountMap.get(obj.id) ?? 0,
      filtered: filteredMap.get(obj.id) ?? [],
      authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null,
      authorSupportsCalls: authorExtras.get(obj.actorId)?.supportsCalls,
      authorMoved: authorExtras.get(obj.actorId)?.moved ?? null,
      bookmarked: bookmarkedIds.has(obj.id),
      muted: mutedIds.has(obj.actorId),
      authorFields: authorFieldsMap.get(obj.actorId) ?? [],
    });
    if (!entry.boost) return serialized;
    // Profile boosts are always by the profile's own account.
    return serializeReblog(actor, serialized, {
      id: encodeStatusId(entry.boost.id, true),
      createdAt: entry.boost.createdAt,
      localDomain: domain,
      emojis: allEmojis,
    });
  });

  // Entries whose author is not cached cannot render an account: drop them.
  const serializedStatuses = statuses.filter((s): s is NonNullable<typeof s> => s !== null);

  const response = json(serializedStatuses);
  if (serializedStatuses.length > 0) {
    const oldest = serializedStatuses[serializedStatuses.length - 1] as { id: string };
    response.headers.set("Link", buildPaginationLinks(request, oldest.id));
  }
  return response;
}
