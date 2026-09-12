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

  const { getListTimeline, getActorsByIds, getAttachmentsByObjectIds, getAllCustomEmojis, getReplyToAccountIdMap, getLastStatusAtMap, getActorFieldsMap, getMutedActorIds } = await import("@/lib/db");
  const objects = await getListTimeline(env.DB, listId, me.id, limit, maxId, sinceId);
  if (objects.length === 0) return json([]);
  const { serializeStatus } = await import("@/lib/mastodon/serializers");
  const objectIds = objects.map((o) => o.id);
  const objs = objects;
  const [attachmentMap, allEmojis, replyToMap, filteredMap, lastStatusAtMap, mutedIds, authorMap] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objectIds),
    getAllCustomEmojis(env.DB),
    getReplyToAccountIdMap(env.DB, objs),
    getFilterResultsForStatuses(env.DB, me.id, objs),
    getLastStatusAtMap(env.DB, objs.map((o) => o.actorId)),
    getMutedActorIds(env.DB, me.id).then((ids) => new Set(ids)),
    getActorsByIds(env.DB, objs.map((o) => o.actorId)),
  ]);
  const authorExtras = await getStatusAuthorExtras(env.DB, objs.map((o) => o.actorId), domain);
  const authorFieldsMap = await getActorFieldsMap(env.DB, objs.map((o) => o.actorId));
  const statuses = await Promise.all(
    objs.map(async (obj) => {
      const author = authorMap.get(obj.actorId) ?? null;
      if (!author) return null;
      return serializeStatus(obj, author, domain, { attachments: attachmentMap.get(obj.id) ?? [], emojis: allEmojis, inReplyToAccountId: replyToMap.get(obj.id) ?? null, filtered: filteredMap.get(obj.id) ?? [], authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null, authorSupportsCalls: authorExtras.get(obj.actorId)?.supportsCalls, authorMoved: authorExtras.get(obj.actorId)?.moved ?? null, authorFields: authorFieldsMap.get(obj.actorId) ?? [], muted: mutedIds.has(obj.actorId) });
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
