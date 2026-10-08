import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, deleteBookmark, canViewStatus, isAcceptedFollower } from "@/lib/db";
import { serializeStatusForStream, loadViewerStatusState } from "@/lib/streaming/serialize";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { env } from "cloudflare:workers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const domain = new URL(request.url).hostname;
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const objectId = decodeStatusId(id, domain);
  const obj = await getObjectById(env.DB, decodeURIComponent(objectId));
  if (!obj) return notFound();
  const isFollowing = obj.actorId === actor.id ? false : await isAcceptedFollower(env.DB, actor.id, obj.actorId);
  if (!canViewStatus(obj, actor.id, isFollowing)) return notFound();

  await deleteBookmark(env.DB, actor.id, obj.id);

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound();

  const viewerState = await loadViewerStatusState(env.DB, actor.id, obj);
  return json(await serializeStatusForStream(env.DB, obj, author, domain, {
    ...viewerState,
    viewerId: actor.id,
    bookmarked: false,
  }));
}
