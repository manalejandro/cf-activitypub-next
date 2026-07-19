import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, getAttachmentsByObjectId } from "@/lib/db";
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
  const attachments = await getAttachmentsByObjectId(env.DB, id);
  return json(serializeStatus(obj, author, domain, { attachments }));
}
