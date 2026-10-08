import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById } from "@/lib/db";
import { serializeStatusForStream, loadViewerStatusState } from "@/lib/streaming/serialize";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { env } from "cloudflare:workers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const domain = new URL(_request.url).hostname;
  const rawId = (await params).id;
  const id = decodeStatusId(rawId, domain);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const obj = await getObjectById(env.DB, id);
  if (!obj) return notFound();
  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound();
  const viewerState = await loadViewerStatusState(env.DB, me.id, obj);
  return json(await serializeStatusForStream(env.DB, obj, author, domain, {
    ...viewerState,
    viewerId: me.id,
    muted: false,
  }));
}
