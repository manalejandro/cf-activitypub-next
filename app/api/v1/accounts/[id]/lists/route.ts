import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { toIsoOrNull } from "@/lib/dates";
import { getAuthenticatedActor } from "@/lib/auth";
import { env } from "cloudflare:workers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const rows = await env.DB
    .prepare(
      `SELECT l.id, l.title, l.replies_policy, l.exclusive, l.created_at, l.updated_at
       FROM lists l
       JOIN list_accounts la ON la.list_id = l.id
       WHERE l.actor_id = ? AND la.actor_id = ?
       ORDER BY l.title`
    )
    .bind(me.id, rawId)
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    replies_policy: r.replies_policy as string,
    exclusive: Boolean(r.exclusive),
    created_at: toIsoOrNull(r.created_at) ?? new Date().toISOString(),
    updated_at: toIsoOrNull(r.updated_at) ?? new Date().toISOString(),
  })));
}
