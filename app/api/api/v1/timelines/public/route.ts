import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getPublicTimeline, getActorById } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";

// GET /api/v1/timelines/public
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 40);
  const maxId = searchParams.get("max_id") ?? undefined;
  const local = searchParams.get("local") === "true";

  const objects = await getPublicTimeline(env.DB, limit, maxId);

  const statuses = await Promise.all(
    objects.map(async (obj) => {
      const author = await getActorById(env.DB, obj.actorId);
      if (!author) return null;
      return serializeStatus(obj, author, domain);
    })
  );

  const result = statuses.filter(Boolean);

  const response = json(result);
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    response.headers.set(
      "Link",
      `<${request.url.split("?")[0]}?max_id=${oldest.id}>; rel="next"`
    );
  }

  return response;
}
