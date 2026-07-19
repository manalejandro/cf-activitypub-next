import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const ids = request.nextUrl.searchParams.get("id")?.split(",") ?? [];
  if (ids.length === 0) return json([]);
  const myFollowing = await env.DB
    .prepare("SELECT target_id FROM follows WHERE actor_id = ? AND state = 'accepted'")
    .bind(me.id)
    .all<{ target_id: string }>();
  const myFollowingSet = new Set(myFollowing.results.map((r) => r.target_id));
  const results = await Promise.all(
    ids.map(async (id) => {
      const theirFollowing = await env.DB
        .prepare("SELECT target_id FROM follows WHERE actor_id = ? AND state = 'accepted'")
        .bind(id)
        .all<{ target_id: string }>();
      const familiar = theirFollowing.results
        .filter((r) => myFollowingSet.has(r.target_id))
        .map((r) => ({ id: r.target_id }));
      return { id, accounts: familiar };
    })
  );
  return json(results);
}
