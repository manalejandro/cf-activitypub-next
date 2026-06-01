import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

// GET /api/v1/follow_requests
// Returns accounts that have requested to follow the authenticated user.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "40"),
    80
  );

  // Query pending follows targeting the authenticated actor
  const rows = await env.DB
    .prepare(
      `SELECT actor_id FROM follows WHERE target_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT ?`
    )
    .bind(actor.id, limit)
    .all<{ actor_id: string }>();

  const accounts = (
    await Promise.all(
      rows.results.map(async (row) => {
        const requester = await getActorById(env.DB, row.actor_id);
        if (!requester) return null;
        return serializeAccount(requester, domain);
      })
    )
  ).filter(Boolean);

  return json(accounts);
}
