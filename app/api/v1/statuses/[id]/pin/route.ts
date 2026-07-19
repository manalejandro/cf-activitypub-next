import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, getAttachmentsByObjectId, getAllCustomEmojis } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(_request.url).hostname;
  const rawId = (await params).id;
  const id = decodeStatusId(rawId, domain);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const obj = await getObjectById(env.DB, id);
  if (!obj) return notFound();
  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound();
  const existing = await env.DB
    .prepare("SELECT id FROM status_pins WHERE actor_id = ? AND status_id = ?")
    .bind(me.id, id)
    .first<{ id: string }>();
  if (!existing) {
    const pinId = `pin_${id}_${me.id}`;
    await env.DB
      .prepare("INSERT INTO status_pins (id, actor_id, status_id) VALUES (?, ?, ?)")
      .bind(pinId, me.id, id)
      .run();
  }
  const [attachments, allEmojis] = await Promise.all([
    getAttachmentsByObjectId(env.DB, id),
    getAllCustomEmojis(env.DB),
  ]);
  return json(serializeStatus(obj, author, domain, { pinned: true, attachments, emojis: allEmojis }));
}
