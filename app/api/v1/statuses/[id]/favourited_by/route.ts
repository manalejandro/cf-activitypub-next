import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getObjectById, getActorById } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

// GET /api/v1/statuses/:id/favourited_by
// Returns accounts that liked the given status.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "40"), 80);

  const rows = await env.DB
    .prepare(
      `SELECT a.* FROM likes l JOIN actors a ON a.id = l.actor_id
       WHERE l.object_id = ?
       ORDER BY l.created_at DESC
       LIMIT ?`
    )
    .bind(obj.id, limit)
    .all<Record<string, unknown>>();

  const accounts = await Promise.all(
    rows.results.map(async (row) => {
      const actor = await getActorById(env.DB, row.id as string);
      return actor ? serializeAccount(actor, domain) : null;
    })
  );

  return json(accounts.filter(Boolean));
}
