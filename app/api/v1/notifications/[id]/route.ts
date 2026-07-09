import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getNotificationById, getActorById, getObjectById } from "@/lib/db";
import { serializeNotification } from "@/lib/mastodon/serializers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(_request.url).hostname;
  const { id } = await params;

  const actor = await getAuthenticatedActor(_request, env.DB);
  if (!actor) return unauthorized();

  const notif = await getNotificationById(env.DB, id);
  if (!notif || notif.targetAccountId !== actor.id) return notFound();

  const fromActor = await getActorById(env.DB, notif.accountId);
  if (!fromActor) return notFound();

  const object = notif.objectId ? await getObjectById(env.DB, notif.objectId) : null;
  const author = object ? await getActorById(env.DB, object.actorId) : null;

  return json(serializeNotification(notif, fromActor, domain, object ?? undefined, author ?? undefined));
}
