import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getNotifications, getActorById, getObjectById } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeNotification } from "@/lib/mastodon/serializers";

// GET /api/v1/notifications
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 40);
  const maxId = searchParams.get("max_id") ?? undefined;
  const excludeTypes = searchParams.getAll("exclude_types[]");

  const notifications = await getNotifications(env.DB, actor.id, limit, maxId);

  const serialized = await Promise.all(
    notifications
      .filter((n) => !excludeTypes.includes(n.type))
      .map(async (notif) => {
        const fromActor = await getActorById(env.DB, notif.accountId);
        const object = notif.objectId ? await getObjectById(env.DB, notif.objectId) : null;
        const author = object ? await getActorById(env.DB, object.actorId) : null;
        if (!fromActor) return null;
        return serializeNotification(notif, fromActor, domain, object ?? undefined, author ?? undefined);
      })
  );

  return json(serialized.filter(Boolean));
}
