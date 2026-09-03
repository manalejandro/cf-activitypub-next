import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorById, getLastStatusAt } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/directory — public (no auth), like Mastodon.
// Lists discoverable accounts; `local=true` restricts to local accounts.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;

  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0");
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.pageSize)), limits.maxCollectionPage);
  const localOnly = request.nextUrl.searchParams.get("local") === "true";
  const orderParam = request.nextUrl.searchParams.get("order") ?? "active";
  const order = orderParam === "new" || orderParam === "active" ? orderParam : "active";

  // Mastodon: "active" = sort by most recently posted statuses (default),
  // "new" = sort by most recently created profiles.
  const orderClause = order === "new"
    ? "created_at DESC"
    : "(SELECT MAX(published) FROM objects o WHERE o.actor_id = actors.id AND visibility IN ('public', 'unlisted') AND type IN ('Note','Article','Page','Video','Audio','Image','Document','Event','Question','Place')) DESC";

  let query = "SELECT id FROM actors WHERE discoverable = 1 AND suspended = 0";
  const params: unknown[] = [];
  if (localOnly) {
    query += " AND is_local = 1";
  }
  query += ` ORDER BY ${orderClause} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await env.DB.prepare(query).bind(...params).all<{ id: string }>();

  const accounts = await Promise.all(
    rows.results.map(async (r) => {
      const a = await getActorById(env.DB, r.id);
      if (!a) return null;
      const lastStatusAt = await getLastStatusAt(env.DB, a.id);
      return serializeAccount(a, domain, { lastStatusAt });
    })
  );

  return json(accounts.filter(Boolean));
}