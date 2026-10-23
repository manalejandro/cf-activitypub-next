import type { D1Database } from "@cloudflare/workers-types";
import type { LocalObject, MastodonStatus } from "@/lib/types";
import { getActorById, getActorsByIds, getAttachmentsByObjectId, getAttachmentsByObjectIds, getAllCustomEmojis } from "@/lib/db";
import { serializeStatus, loadSerializedPolls } from "@/lib/mastodon/serializers";

/**
 * Serialize a quoted status for embedding in the `quote` attribute. Never
 * nests further quotes to avoid unbounded recursion.
 */
export async function serializeQuote(
  db: D1Database,
  quotedObj: LocalObject | null | undefined,
  localDomain: string,
  viewerId?: string | null
): Promise<MastodonStatus | null> {
  if (!quotedObj) return null;
  const actor = await getActorById(db, quotedObj.actorId);
  if (!actor) return null;
  const [attachments, allEmojis, pollMap] = await Promise.all([
    getAttachmentsByObjectId(db, quotedObj.id),
    getAllCustomEmojis(db),
    loadSerializedPolls(db, viewerId ?? null, [quotedObj.id]),
  ]);
  return serializeStatus(quotedObj, actor, localDomain, {
    attachments,
    favourited: false,
    reblogged: false,
    emojis: allEmojis,
    quote: null,
    // Quoted polls render (read-only) inside the quote card.
    poll: pollMap.get(quotedObj.id) ?? null,
  });
}

/**
 * Fetch quoted objects for a set of statuses in one pass (batch).
 */
export async function getQuotesByIds(
  db: D1Database,
  ids: string[],
  localDomain: string,
  viewerId?: string | null
): Promise<Map<string, MastodonStatus | null>> {
  const map = new Map<string, MastodonStatus | null>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return map;

  // One query for every quoted object plus one batch load for authors,
  // attachments, polls and emojis: the per-quote chain of round trips was a
  // per-status cost on timelines that show quotes (measured on cf-ap).
  const quoted = new Map<string, LocalObject>();
  for (let i = 0; i < unique.length; i += 900) {
    const chunk = unique.slice(i, i + 900);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT * FROM objects WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<Record<string, unknown>>();
    for (const obj of rows.results ?? []) quoted.set(obj.id as string, quoteObjectFromRow(obj));
  }

  const quotedIds = [...quoted.keys()];
  const authorIds = [...new Set([...quoted.values()].map((q) => q.actorId))];
  const [actors, attachmentMap, pollMap, allEmojis] = await Promise.all([
    getActorsByIds(db, authorIds),
    getAttachmentsByObjectIds(db, quotedIds),
    loadSerializedPolls(db, viewerId ?? null, quotedIds),
    getAllCustomEmojis(db),
  ]);

  for (const id of unique) {
    const quotedObj = quoted.get(id);
    const actor = quotedObj ? actors.get(quotedObj.actorId) : undefined;
    if (!quotedObj || !actor) {
      map.set(id, null);
      continue;
    }
    map.set(
      id,
      serializeStatus(quotedObj, actor, localDomain, {
        attachments: attachmentMap.get(id) ?? [],
        favourited: false,
        reblogged: false,
        emojis: allEmojis,
        quote: null,
        // Quoted polls render (read-only) inside the quote card.
        poll: pollMap.get(id) ?? null,
      })
    );
  }
  return map;
}

function quoteObjectFromRow(obj: Record<string, unknown>): LocalObject {
  return {
    id: obj.id as string,
    type: obj.type as string,
    actorId: obj.actor_id as string,
    content: (obj.content as string | null) ?? null,
    contentWarning: (obj.content_warning as string | null) ?? null,
    sensitive: Boolean(obj.sensitive),
    visibility: obj.visibility as "public" | "unlisted" | "private" | "direct",
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
}