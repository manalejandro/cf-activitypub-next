import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, getAttachmentsByObjectId, getLike, getAnnounce } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "20"), 40);

  const rows = await env.DB
    .prepare("SELECT object_id FROM likes WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(actor.id, limit)
    .all<{ object_id: string }>();
  const objectIds = rows.results.map((r) => r.object_id);

  const serialized = await Promise.all(
    objectIds.map(async (oid) => {
      const obj = await getObjectById(env.DB, oid);
      if (!obj) return null;
      const author = await getActorById(env.DB, obj.actorId);
      if (!author) return null;
      const [attachments, reblogged] = await Promise.all([
        getAttachmentsByObjectId(env.DB, obj.id),
        getAnnounce(env.DB, actor.id, obj.id),
      ]);
      return serializeStatus(obj, author, domain, {
        favourited: true,
        reblogged: reblogged !== null,
        attachments,
      });
    })
  );

  return json(serialized.filter(Boolean));
}
