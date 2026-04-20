import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getHomeTimeline, getActorById } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";

// GET /api/v1/timelines/home
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 40);
  const maxId = searchParams.get("max_id") ?? undefined;
  const sinceId = searchParams.get("since_id") ?? undefined;
  const minId = searchParams.get("min_id") ?? undefined;

  const objects = await getHomeTimeline(env.DB, actor.id, limit, maxId);

  const statuses = await Promise.all(
    objects.map(async (obj) => {
      const author = await getActorById(env.DB, obj.actorId);
      if (!author) return null;
      return serializeStatus(obj, author, domain);
    })
  );

  const result = statuses.filter(Boolean);

  const response = json(result);
  // Link header for pagination
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    const newest = result[0] as { id: string };
    response.headers.set(
      "Link",
      `<${request.url.split("?")[0]}?max_id=${oldest.id}>; rel="next", ` +
      `<${request.url.split("?")[0]}?min_id=${newest.id}>; rel="prev"`
    );
  }

  return response;
}
