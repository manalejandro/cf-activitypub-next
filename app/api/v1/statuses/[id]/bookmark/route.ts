import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, getAttachmentsByObjectId, getLike, getAnnounce, getBookmark, createBookmark,
  getLastStatusAtMap} from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { generateId } from "@/lib/activitypub/utils";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const objectId = decodeStatusId(id, domain);
  const obj = await getObjectById(env.DB, objectId);
  if (!obj) return notFound();

  const existing = await getBookmark(env.DB, actor.id, obj.id);
  if (!existing) {
    await createBookmark(env.DB, generateId(), actor.id, obj.id);
  }

  const [author, attachments, favourited, reblogged] = await Promise.all([
    getActorById(env.DB, obj.actorId),
    getAttachmentsByObjectId(env.DB, obj.id),
    getLike(env.DB, actor.id, obj.id),
    getAnnounce(env.DB, actor.id, obj.id),
  ]);

  if (!author) return notFound();

  const authorLastStatusAt = (await getLastStatusAtMap(env.DB, [obj.actorId])).get(obj.actorId) ?? null;
  const authorExtras = (await getStatusAuthorExtras(env.DB, [obj.actorId], domain)).get(obj.actorId);
  return json(serializeStatus(obj, author, domain, {
    favourited: favourited !== null,
    reblogged: reblogged !== null,
    attachments,
    authorLastStatusAt,
    authorSupportsCalls: authorExtras?.supportsCalls,
    authorMoved: authorExtras?.moved ?? null,
  }));
}
