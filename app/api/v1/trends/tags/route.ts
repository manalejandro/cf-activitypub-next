import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/trends/tags
// Returns trending hashtags from the last 7 days.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.trendingTagsLimit)),
    limits.trendingTagsMax
  );

  // The result is identical for every client, so the 7-day aggregation is
  // computed once and served from KV — the DB query only runs on a cache miss.
  const cacheKey = "trends:tags:v1";
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* fall through to recompute */ }

  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString();

  // Aggregated straight from the object_tags index (extracted at ingest):
  // index-only scan of the 7-day window, no JSON parsing of every stored post.
  const rows = await env.DB
    .prepare(
      `SELECT tag, COUNT(*) AS uses, COUNT(DISTINCT actor_id) AS actors
       FROM object_tags
       WHERE published >= ?
       GROUP BY tag
       ORDER BY uses DESC
       LIMIT ?`
    )
    .bind(weekCutoff, limit)
    .all<{ tag: string; uses: number; actors: number }>();

  const sorted = (rows.results ?? [])
    .map((r) => serializeTag(r.tag, domain, Number(r.uses), Number(r.actors)));

  const body = json(sorted);
  await env.KV.put(cacheKey, JSON.stringify(sorted), { expirationTtl: 300 }).catch(() => {});
  return body;
}

function tagId(name: string): string {
  let h = 5381;
  for (const c of name.toLowerCase()) {
    h = (((h << 5) + h) ^ c.charCodeAt(0)) & 0x7fffffff;
  }
  return String(h >>> 0);
}

export function serializeTag(
  name: string,
  domain: string,
  uses = 0,
  accounts = 0
) {
  return {
    id: tagId(name),
    name,
    url: `https://${domain}/tags/${encodeURIComponent(name)}`,
    history: [
      {
        day: String(Math.floor(Date.now() / 1000 / 86400) * 86400),
        uses: String(uses),
        accounts: String(accounts),
      },
    ],
    following: false,
  };
}
