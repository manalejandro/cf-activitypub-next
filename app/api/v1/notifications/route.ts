import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getNotifications, getActorById, getObjectById, getLastStatusAtMap , getBookmarkedObjectIds } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeNotification } from "@/lib/mastodon/serializers";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

// GET /api/v1/notifications
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  const maxId = searchParams.get("max_id") ?? undefined;
  const excludeTypes = searchParams.getAll("exclude_types[]");
  const includeTypes = searchParams.getAll("types[]");

  const notifications = await getNotifications(env.DB, actor.id, limit, maxId);

  const notifObjects = (await Promise.all(
    notifications.map((n) => (n.objectId ? getObjectById(env.DB, n.objectId) : Promise.resolve(null)))
  )).filter((o): o is NonNullable<typeof o> => o !== null);
  const filteredMap = await getFilterResultsForStatuses(env.DB, actor.id, notifObjects);
  const lastStatusAtMap = await getLastStatusAtMap(env.DB, notifObjects.map((o) => o.actorId));
  const authorExtrasMap = await getStatusAuthorExtras(env.DB, notifObjects.map((o) => o.actorId), domain);
  const bookmarkedIds = await getBookmarkedObjectIds(env.DB, actor.id, notifObjects.map((o) => o.id));

  const serialized = await Promise.all(
    notifications
      .filter((n) => !excludeTypes.includes(n.type))
      .filter((n) => includeTypes.length === 0 || includeTypes.includes(n.type))
      .map(async (notif) => {
        const fromActor = await getActorById(env.DB, notif.accountId);
        const object = notif.objectId ? await getObjectById(env.DB, notif.objectId) : null;
        const author = object ? await getActorById(env.DB, object.actorId) : null;
        if (!fromActor) return null;
        return serializeNotification(notif, fromActor, domain, object ?? undefined, author ?? undefined, object ? (filteredMap.get(object.id) ?? []) : undefined, object ? (lastStatusAtMap.get(object.actorId) ?? null) : undefined, object ? authorExtrasMap.get(object.actorId) : undefined, object ? bookmarkedIds.has(object.id) : undefined);
      })
  );

  const result = serialized.filter(Boolean);
  const response = json(result);
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    response.headers.set("Link", buildPaginationLinks(request, oldest.id));
  }
  return response;
}
