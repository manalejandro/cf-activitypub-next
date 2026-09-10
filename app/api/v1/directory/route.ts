import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorsByIds, getLastStatusAtMap, PUBLIC_STATUS_TYPE_SQL } from "@/lib/db";
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

  // The ranking is identical for every client; cache the serialized page so a
  // popular directory view doesn't re-run the ordered scan on every request.
  const cacheKey = `directory:v1:${domain}:${order}:${localOnly ? 1 : 0}:${limit}:${offset}`;
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* fall through to DB */ }

  // Mastodon: "active" = sort by most recently posted statuses (default),
  // "new" = sort by most recently created profiles. The active order reads
  // actors.last_status_at (maintained on object writes) so the ordered index
  // scan (idx_actors_discoverable_active) replaces a per-actor MAX() subquery
  // over objects. Pre-migration fallback: compute it from objects.
  const legacyActiveOrder = `(SELECT MAX(published) FROM objects o WHERE o.actor_id = actors.id AND visibility IN ('public', 'unlisted') AND type IN (${PUBLIC_STATUS_TYPE_SQL})) DESC`;
  const orderClause = order === "new" ? "created_at DESC" : "last_status_at DESC";

  let query = "SELECT id FROM actors WHERE discoverable = 1 AND suspended = 0";
  if (localOnly) query += " AND is_local = 1";
  query += ` ORDER BY ${orderClause} LIMIT ? OFFSET ?`;

  let rows: { id: string }[];
  try {
    rows = (await env.DB.prepare(query).bind(limit, offset).all<{ id: string }>()).results ?? [];
  } catch (e) {
    // Pre-migration (actors.last_status_at missing): old correlated subquery.
    if (order !== "active") throw e;
    const fallback = `SELECT id FROM actors WHERE discoverable = 1 AND suspended = 0${localOnly ? " AND is_local = 1" : ""} ORDER BY ${legacyActiveOrder} LIMIT ? OFFSET ?`;
    rows = (await env.DB.prepare(fallback).bind(limit, offset).all<{ id: string }>()).results ?? [];
  }

  const ids = rows.map((r) => r.id);
  const [authorMap, lastStatusAtMap] = await Promise.all([
    getActorsByIds(env.DB, ids),
    getLastStatusAtMap(env.DB, ids),
  ]);
  const accounts = ids
    .map((id) => {
      const a = authorMap.get(id);
      if (!a) return null;
      return serializeAccount(a, domain, { lastStatusAt: lastStatusAtMap.get(id) ?? null });
    })
    .filter(Boolean);

  await env.KV.put(cacheKey, JSON.stringify(accounts), { expirationTtl: 300 }).catch(() => {});
  return json(accounts);
}
