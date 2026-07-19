import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

export async function GET(request: NextRequest): Promise<Response> {
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "10"), 20);
  const { env } = getCloudflareContext();
  const rows = await env.DB
    .prepare(
      `SELECT value->>'$.name' as tag_name, COUNT(*) as count
       FROM objects, json_each(objects.raw, '$.tag') AS value
       WHERE value->>'$.type' = 'Hashtag'
         AND objects.visibility IN ('public', 'unlisted')
         AND objects.published >= datetime('now', '-7 days')
       GROUP BY tag_name
       ORDER BY count DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ tag_name: string; count: number }>();
  return json(rows.results.map((r) => ({
    name: r.tag_name.startsWith("#") ? r.tag_name.slice(1) : r.tag_name,
    url: "",
    history: [],
    statuses_count: r.count,
    following: false,
  })));
}
