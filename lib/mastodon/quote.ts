import type { D1Database } from "@cloudflare/workers-types";
import type { LocalObject, MastodonStatus } from "@/lib/types";
import { getActorById, getAttachmentsByObjectId, getAllCustomEmojis } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";

/**
 * Serialize a quoted status for embedding in the `quote` attribute. Never
 * nests further quotes to avoid unbounded recursion.
 */
export async function serializeQuote(
  db: D1Database,
  quotedObj: LocalObject | null | undefined,
  localDomain: string
): Promise<MastodonStatus | null> {
  if (!quotedObj) return null;
  const actor = await getActorById(db, quotedObj.actorId);
  if (!actor) return null;
  const [attachments, allEmojis] = await Promise.all([
    getAttachmentsByObjectId(db, quotedObj.id),
    getAllCustomEmojis(db),
  ]);
  return serializeStatus(quotedObj, actor, localDomain, {
    attachments,
    favourited: false,
    reblogged: false,
    emojis: allEmojis,
    quote: null,
  });
}

/**
 * Fetch quoted objects for a set of statuses in one pass (batch).
 */
export async function getQuotesByIds(
  db: D1Database,
  ids: string[],
  localDomain: string
): Promise<Map<string, MastodonStatus | null>> {
  const map = new Map<string, MastodonStatus | null>();
  for (const id of ids) {
    if (!id || map.has(id)) continue;
    const obj = await db
      .prepare("SELECT * FROM objects WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!obj) {
      map.set(id, null);
      continue;
    }
    const quoted = {
      id: obj.id as string,
      type: obj.type as string,
      actorId: obj.actor_id as string,
      content: (obj.content as string | null) ?? null,
      contentWarning: (obj.content_warning as string | null) ?? null,
      sensitive: Boolean(obj.sensitive),
      visibility: obj.visibility as "public" | "unlisted" | "followers" | "direct",
      inReplyToId: (obj.in_reply_to_id as string | null) ?? null,
      quoteId: (obj.quote_id as string | null) ?? null,
      language: (obj.language as string | null) ?? null,
      url: obj.url as string,
      repliesCount: Number(obj.replies_count ?? 0),
      reblogsCount: Number(obj.reblogs_count ?? 0),
      favouritesCount: Number(obj.favourites_count ?? 0),
      published: obj.published as string,
      updatedAt: obj.updated_at as string,
      local: Boolean(obj.is_local),
      raw: obj.raw as string,
    } as LocalObject;
    map.set(id, await serializeQuote(db, quoted, localDomain));
  }
  return map;
}