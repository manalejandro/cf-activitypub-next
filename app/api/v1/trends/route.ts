import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { resolveLimits } from "@/lib/constants";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.trendingTagsLimit)),
    limits.trendingTagsMax
  );

  // Aggregated from the object_tags index (extracted at ingest) instead of
  // scanning and JSON-parsing the last 7 days of stored posts.
  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = await env.DB
    .prepare(
      `SELECT tag, COUNT(*) AS c
       FROM object_tags
       WHERE published >= ?
       GROUP BY tag
       ORDER BY c DESC
       LIMIT ?`
    )
    .bind(weekCutoff, limit)
    .all<{ tag: string; c: number }>();

  const sorted = (rows.results ?? []).map((r) => ({
    name: r.tag,
    url: "",
    history: [],
    statuses_count: Number(r.c),
    following: false,
  }));

  return json(sorted);
}
