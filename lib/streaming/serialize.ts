import type { D1Database } from "@cloudflare/workers-types";
import type { LocalActor, LocalObject, MastodonStatus } from "@/lib/types";
import {
  getAllCustomEmojis,
  getAttachmentsByObjectIds,
  getLastStatusAtMap,
  getObjectQuotesCounts,
} from "@/lib/db";
import { loadSerializedPolls, serializeStatus } from "@/lib/mastodon/serializers";
import { getQuotesByIds } from "@/lib/mastodon/quote";
import { parentExclusion } from "@/lib/streaming/broadcast";

/**
 * Serialize a stored status for a streaming event with its full media context
 * (attachments, custom emojis, poll, quote, parent author).
 *
 * Stream payloads replace the client's cached copy — `mergeStatusUpdate` keeps
 * only the viewer-specific fields — so a partial payload silently wipes what is
 * already on screen: the boost refresh used to serialize without attachments,
 * and every cached status (and its boosts) lost its images the moment it was
 * boosted. Anything that streams a full status must go through this helper.
 */
export async function serializeStatusForStream(
  db: D1Database,
  obj: LocalObject,
  author: LocalActor,
  domain: string,
  opts: { viewerId?: string | null } = {}
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
  });
}
