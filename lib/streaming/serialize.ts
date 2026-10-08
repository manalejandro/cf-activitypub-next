import type { D1Database } from "@cloudflare/workers-types";
import type { LocalActor, LocalObject, MastodonAccount, MastodonStatus } from "@/lib/types";
import {
  getAllCustomEmojis,
  getAnnouncedObjectIds,
  getAttachmentsByObjectIds,
  getBookmarkedObjectIds,
  getLastStatusAtMap,
  getLikedObjectIds,
  getMutedActorIds,
  getObjectQuotesCounts,
} from "@/lib/db";
import { loadSerializedPolls, serializeStatus } from "@/lib/mastodon/serializers";
import { getQuotesByIds } from "@/lib/mastodon/quote";
import { getFilterResultsForStatuses, type FilterResult } from "@/lib/mastodon/filters";
import { parentExclusion } from "@/lib/streaming/broadcast";

/** Viewer-specific fields and author extras an interaction response carries. */
export interface StatusContextOverrides {
  /** Viewer for viewer-aware fields (poll votes, quote). */
  viewerId?: string | null;
  favourited?: boolean;
  reblogged?: boolean;
  bookmarked?: boolean;
  pinned?: boolean;
  muted?: boolean;
  filtered?: FilterResult[];
  authorSupportsCalls?: boolean;
  authorMoved?: MastodonAccount | null;
}

/**
 * Every viewer-specific field of a status (favourite, reblog, bookmark, pin,
 * mute, filters). Interaction responses replace the client's cached copy, so a
 * route that only set the field it changed would silently clear the rest —
 * unfavouriting a post wiped its bookmark icon, for example.
 */
export async function loadViewerStatusState(
  db: D1Database,
  viewerId: string,
  obj: LocalObject
): Promise<StatusContextOverrides> {
  const [liked, announced, bookmarked, mutedIds, filteredMap, pinnedRow] = await Promise.all([
    getLikedObjectIds(db, viewerId, [obj.id]),
    getAnnouncedObjectIds(db, viewerId, [obj.id]),
    getBookmarkedObjectIds(db, viewerId, [obj.id]),
    getMutedActorIds(db, viewerId),
    getFilterResultsForStatuses(db, viewerId, [obj]),
    db
      .prepare("SELECT 1 AS p FROM status_pins WHERE actor_id = ? AND status_id = ? LIMIT 1")
      .bind(viewerId, obj.id)
      .first<{ p: number }>()
      .catch(() => null),
  ]);
  return {
    favourited: liked.has(obj.id),
    reblogged: announced.has(obj.id),
    bookmarked: bookmarked.has(obj.id),
    pinned: pinnedRow !== null,
    muted: mutedIds.includes(obj.actorId),
    filtered: filteredMap.get(obj.id) ?? [],
  };
}

/**
 * Serialize a stored status with its full media context (attachments, custom
 * emojis, poll, quote, parent author) plus optional viewer state.
 *
 * Stream payloads and interaction responses replace the client's cached copy —
 * `mergeStatusUpdate` keeps only the viewer fields — so a partial payload
 * silently wipes what is already on screen: the boost refresh serialized
 * without attachments and every cached status lost its images the moment it was
 * boosted, and interaction routes serialized without `quote`, so favouriting a
 * quote made its card disappear. Anything that sends a status to a client (or a
 * stream) must go through this helper.
 */
export async function serializeStatusForStream(
  db: D1Database,
  obj: LocalObject,
  author: LocalActor,
  domain: string,
  opts: StatusContextOverrides = {}
): Promise<MastodonStatus> {
  const viewerId = opts.viewerId ?? null;
  const [attachmentMap, pollMap, emojis, quotesCountMap, quotesById, lastStatusAtMap, parent] = await Promise.all([
    getAttachmentsByObjectIds(db, [obj.id]),
    loadSerializedPolls(db, viewerId, [obj.id]),
    getAllCustomEmojis(db),
    getObjectQuotesCounts(db, [obj.id]),
    obj.quoteId
      ? getQuotesByIds(db, [obj.quoteId], domain, viewerId)
      : Promise.resolve(new Map<string, MastodonStatus | null>()),
    getLastStatusAtMap(db, [obj.actorId]),
    parentExclusion(db, obj.inReplyToId),
  ]);
  return serializeStatus(obj, author, domain, {
    attachments: attachmentMap.get(obj.id) ?? [],
    emojis,
    poll: pollMap.get(obj.id) ?? null,
    quote: obj.quoteId ? (quotesById.get(obj.quoteId) ?? null) : null,
    quotesCount: quotesCountMap.get(obj.id) ?? 0,
    inReplyToAccountId: parent?.id ?? null,
    authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null,
    favourited: opts.favourited ?? false,
    reblogged: opts.reblogged ?? false,
    bookmarked: opts.bookmarked ?? false,
    pinned: opts.pinned ?? false,
    muted: opts.muted ?? false,
    filtered: opts.filtered ?? [],
    authorSupportsCalls: opts.authorSupportsCalls,
    authorMoved: opts.authorMoved ?? null,
  });
}
