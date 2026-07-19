import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

export async function GET(request: NextRequest): Promise<Response> {
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "10"), 20);
  const { env } = getCloudflareContext();

  const rows = await env.DB
    .prepare(
      `SELECT raw
       FROM objects
       WHERE json_valid(raw)
         AND visibility IN ('public', 'unlisted')
         AND published >= datetime('now', '-7 days')
       LIMIT 500`
    )
    .all<{ raw: string }>();

  const tagCount = new Map<string, number>();
  for (const r of rows.results) {
    let parsed: { tag?: { type?: string; name?: string }[] };
    try { parsed = JSON.parse(r.raw); } catch { continue; }
    const tags = parsed.tag ?? [];
    for (const t of tags) {
      if (t.type === "Hashtag" && t.name) {
        const name = t.name.replace(/^#/, "");
        tagCount.set(name, (tagCount.get(name) ?? 0) + 1);
      }
    }
  }

  const sorted = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({
      name,
      url: "",
      history: [],
      statuses_count: count,
      following: false,
    }));

  return json(sorted);
}
