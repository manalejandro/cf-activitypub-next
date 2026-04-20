import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, deleteAnnounce, getAnnounce } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";

// POST /api/v1/statuses/:id/unreblog
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const obj = await getObjectById(env.DB, decodeURIComponent(id));
  if (!obj) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound("Author not found");

  await deleteAnnounce(env.DB, actor.id, obj.id);

  const refreshed = await getObjectById(env.DB, obj.id);
  return json(serializeStatus(refreshed ?? obj, author, domain, { reblogged: false }));
}
