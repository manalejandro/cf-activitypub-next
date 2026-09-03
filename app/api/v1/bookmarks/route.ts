import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getBookmarkedStatusIds, getObjectById, getActorById, getAttachmentsByObjectId, getLike, getAnnounce, getLastStatusAtMap  , getActorFieldsMap } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);

  const objectIds = await getBookmarkedStatusIds(env.DB, actor.id);
  const sliced = objectIds.slice(0, limit);

  const objs = (await Promise.all(sliced.map((oid) => getObjectById(env.DB, oid)))).filter((o): o is NonNullable<typeof o> => o !== null);
  const filteredMap = await getFilterResultsForStatuses(env.DB, actor.id, objs);
  const lastStatusAtMap = await getLastStatusAtMap(env.DB, objs.map((o) => o.actorId));
  const authorExtras = await getStatusAuthorExtras(env.DB, objs.map((o) => o.actorId), domain);
  const authorFieldsMap = await getActorFieldsMap(env.DB, objs.map((o) => o.actorId));

  const serialized = await Promise.all(
    objs.map(async (obj) => {
      const author = await getActorById(env.DB, obj.actorId);
      if (!author) return null;
      const [attachments, favourited, reblogged] = await Promise.all([
        getAttachmentsByObjectId(env.DB, obj.id),
        getLike(env.DB, actor.id, obj.id),
        getAnnounce(env.DB, actor.id, obj.id),
      ]);
      return serializeStatus(obj, author, domain, {
        favourited: favourited !== null,
        reblogged: reblogged !== null,
        attachments,
        filtered: filteredMap.get(obj.id) ?? [],
        authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null,
        authorSupportsCalls: authorExtras.get(obj.actorId)?.supportsCalls,
        authorMoved: authorExtras.get(obj.actorId)?.moved ?? null,
        bookmarked: true,
        authorFields: authorFieldsMap.get(obj.actorId) ?? [],
      });
    })
  );

  return json(serialized.filter(Boolean));
}
