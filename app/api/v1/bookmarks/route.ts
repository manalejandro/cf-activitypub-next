import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getBookmarkedStatusIds, getObjectById, getActorById, getAttachmentsByObjectId, getLike, getAnnounce } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);

  const objectIds = await getBookmarkedStatusIds(env.DB, actor.id);
  const sliced = objectIds.slice(0, limit);

  const serialized = await Promise.all(
    sliced.map(async (oid) => {
      const obj = await getObjectById(env.DB, oid);
      if (!obj) return null;
      const author = await getActorById(env.DB, obj.actorId);
      if (!author) return null;
      const [attachments, favourited, reblogged] = await Promise.all([
        getAttachmentsByObjectId(env.DB, obj.id),
        getLike(env.DB, actor.id, obj.id),
        getAnnounce(env.DB, actor.id, obj.id),
      ]);
      return serializeStatus(obj, author, domain, {
        favourited: favourited !== null,
        reblogged: reblogged !== null,
        attachments,
      });
    })
  );

  return json(serialized.filter(Boolean));
}
