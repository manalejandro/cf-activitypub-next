import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const listId = request.nextUrl.searchParams.get("list_id") ?? "";
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  const maxIdRaw = request.nextUrl.searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const sinceIdRaw = request.nextUrl.searchParams.get("since_id") ?? undefined;
  const sinceId = sinceIdRaw ? decodeStatusId(sinceIdRaw, domain) : undefined;
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();

  const where = `la.list_id = ?
     AND o.visibility IN ('public', 'unlisted')
     AND o.actor_id NOT IN (SELECT target_id FROM blocks WHERE actor_id = ?)
     AND NOT EXISTS (SELECT 1 FROM actors ba WHERE ba.id = o.actor_id AND ba.domain IN (SELECT domain FROM domain_blocks WHERE actor_id = ?))`;
  let sql = `SELECT o.* FROM objects o
     JOIN list_accounts la ON la.actor_id = o.actor_id
     WHERE ${where}`;
  const args: unknown[] = [listId, me.id, me.id];

  if (maxId) {
    sql += ` AND o.published < (SELECT published FROM objects WHERE id = ?)`;
    args.push(maxId);
  } else if (sinceId) {
    sql += ` AND o.published > (SELECT published FROM objects WHERE id = ?)`;
    args.push(sinceId);
  }
  sql += ` ORDER BY o.published DESC LIMIT ?`;
  args.push(limit);

  const rows = await env.DB
    .prepare(sql)
    .bind(...args)
    .all<Record<string, unknown>>();
  if (rows.results.length === 0) return json([]);
  const { getActorById, getAttachmentsByObjectIds, getAllCustomEmojis, getReplyToAccountIdMap, getLastStatusAtMap, getActorFieldsMap } = await import("@/lib/db");
  const { serializeStatus } = await import("@/lib/mastodon/serializers");
  const objectIds = rows.results.map((r) => r.id as string);
  const objs = rows.results.map((r) => ({
    id: r.id as string,
    type: r.type as string,
    actorId: r.actor_id as string,
    content: r.content as string | null,
    contentWarning: r.content_warning as string | null,
    sensitive: Boolean(r.sensitive),
    visibility: r.visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyToId: r.in_reply_to_id as string | null,
    quoteId: (r.quote_id as string | null) ?? null,
    language: r.language as string | null,
    url: r.url as string,
    repliesCount: Number(r.replies_count ?? 0),
    reblogsCount: Number(r.reblogs_count ?? 0),
    favouritesCount: Number(r.favourites_count ?? 0),
    published: r.published as string,
    updatedAt: r.updated_at as string,
    local: Boolean(r.is_local),
    raw: r.raw as string,
  }));
  const [attachmentMap, allEmojis, replyToMap, filteredMap, lastStatusAtMap] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objectIds),
    getAllCustomEmojis(env.DB),
    getReplyToAccountIdMap(env.DB, objs),
    getFilterResultsForStatuses(env.DB, me.id, objs),
    getLastStatusAtMap(env.DB, objs.map((o) => o.actorId)),
  ]);
  const authorExtras = await getStatusAuthorExtras(env.DB, objs.map((o) => o.actorId), domain);
  const authorFieldsMap = await getActorFieldsMap(env.DB, objs.map((o) => o.actorId));
  const statuses = await Promise.all(
    objs.map(async (obj) => {
      const author = await getActorById(env.DB, obj.actorId);
      if (!author) return null;
      return serializeStatus(obj, author, domain, { attachments: attachmentMap.get(obj.id) ?? [], emojis: allEmojis, inReplyToAccountId: replyToMap.get(obj.id) ?? null, filtered: filteredMap.get(obj.id) ?? [], authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null, authorSupportsCalls: authorExtras.get(obj.actorId)?.supportsCalls, authorMoved: authorExtras.get(obj.actorId)?.moved ?? null, authorFields: authorFieldsMap.get(obj.actorId) ?? [] });
    })
  );
  const result = statuses.filter(Boolean);
  const response = json(result);
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    response.headers.set("Link", buildPaginationLinks(request, oldest.id));
  }
  return response;
}
