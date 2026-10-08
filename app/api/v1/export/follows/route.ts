import { type NextRequest } from "next/server";
import { unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { env } from "cloudflare:workers";

// GET /api/v1/export/follows — Mastodon-compatible following-list CSV
// Columns: Account address (plus Show boosts, always false) so it round-trips
// with Mastodon and with our import endpoint.
export async function GET(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const rows = await env.DB
    .prepare(
      `SELECT a.username, a.domain FROM follows f
       JOIN actors a ON a.id = f.target_id
       WHERE f.actor_id = ? AND f.state = 'accepted'
       ORDER BY a.domain, a.username`
    )
    .bind(actor.id)
    .all<{ username: string; domain: string }>();

  const lines = ["Account address,Show boosts"];
  for (const r of rows.results) {
    const acct = r.domain === new URL(request.url).hostname
      ? r.username
      : `${r.username}@${r.domain}`;
    lines.push(`${acct},false`);
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="following.csv"',
    },
  });
}