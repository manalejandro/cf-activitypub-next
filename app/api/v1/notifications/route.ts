import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getNotifications, getActorsByIds, getObjectsByIds, getLastStatusAtMap , getBookmarkedObjectIds, getMutedActorIds, getActorFieldsMap } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeNotification } from "@/lib/mastodon/serializers";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { clampLimit, resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";
import { env } from "cloudflare:workers";

// GET /api/v1/notifications
export async function GET(request: NextRequest): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = clampLimit(searchParams.get("limit"), limits.defaultTimelinePage, limits.maxPageSize);
  const maxId = searchParams.get("max_id") ?? undefined;
  const excludeTypes = searchParams.getAll("exclude_types[]");
  const includeTypes = searchParams.getAll("types[]");
  // Limited-account policy: filtered notifications are hidden by default and
  // live in their own tab (`filtered=true`).
  const filteredOnly = searchParams.get("filtered") === "true";

  const notifications = await getNotifications(env.DB, actor.id, limit, maxId, {
    include: includeTypes,
    exclude: excludeTypes,
    filtered: filteredOnly,
  });

  // Batch every lookup (AGENTS: a page must never make a round trip per row).
  // Objects are resolved once here and reused for the enrichment maps AND the
  // serialization below — the old code fetched each object twice and each actor
  // (sender + author) per row, ~80 D1 round trips for a page of 20.
  const objectIds = notifications.map((n) => n.objectId).filter((v): v is string => !!v);
  const objectMap = await getObjectsByIds(env.DB, objectIds);
  const notifObjects = [...objectMap.values()];
  const filteredMap = await getFilterResultsForStatuses(env.DB, actor.id, notifObjects);
  const lastStatusAtMap = await getLastStatusAtMap(env.DB, notifObjects.map((o) => o.actorId));
  const authorExtrasMap = await getStatusAuthorExtras(env.DB, notifObjects.map((o) => o.actorId), domain);
  const bookmarkedIds = await getBookmarkedObjectIds(env.DB, actor.id, notifObjects.map((o) => o.id));
  const mutedIds = new Set(await getMutedActorIds(env.DB, actor.id));
  const authorFieldsMap = await getActorFieldsMap(env.DB, notifObjects.map((o) => o.actorId));

  // One batch for every actor the page references: the notification sender and
  // each object's author.
  const actorIds = new Set<string>();
  for (const n of notifications) actorIds.add(n.accountId);
  for (const o of notifObjects) actorIds.add(o.actorId);
  const actorsMap = await getActorsByIds(env.DB, [...actorIds]);

  const serialized = notifications
    .map((notif) => {
      const fromActor = actorsMap.get(notif.accountId) ?? null;
      if (!fromActor) return null;
      const object = notif.objectId ? objectMap.get(notif.objectId) ?? null : null;
      const author = object ? actorsMap.get(object.actorId) ?? null : null;
      return serializeNotification(notif, fromActor, domain, object ?? undefined, author ?? undefined, object ? (filteredMap.get(object.id) ?? []) : undefined, object ? (lastStatusAtMap.get(object.actorId) ?? null) : undefined, object ? authorExtrasMap.get(object.actorId) : undefined, object ? bookmarkedIds.has(object.id) : undefined, object ? authorFieldsMap.get(object.actorId) : undefined, object ? mutedIds.has(object.actorId) : undefined);
    });

  const result = serialized.filter(Boolean);
  const response = json(result);
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    response.headers.set("Link", buildPaginationLinks(request, oldest.id));
  }
  return response;
}
