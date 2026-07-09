import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, getAttachmentsByObjectId, getLike, getAnnounce, deleteBookmark } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const objectId = decodeStatusId(id, domain);
  const obj = await getObjectById(env.DB, objectId);
  if (!obj) return notFound();

  await deleteBookmark(env.DB, actor.id, obj.id);

  const [author, attachments, favourited, reblogged] = await Promise.all([
    getActorById(env.DB, obj.actorId),
    getAttachmentsByObjectId(env.DB, obj.id),
    getLike(env.DB, actor.id, obj.id),
    getAnnounce(env.DB, actor.id, obj.id),
  ]);

  if (!author) return notFound();

  return json(serializeStatus(obj, author, domain, {
    favourited: favourited !== null,
    reblogged: reblogged !== null,
    attachments,
  }));
}
