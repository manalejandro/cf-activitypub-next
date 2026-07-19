import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

// GET /api/v1/trends/tags
// Returns trending hashtags from the last 7 days.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "10"),
    20
  );

  // Fetch recent public objects and parse hashtags in JS
  const rows = await env.DB
    .prepare(
      `SELECT id, actor_id, raw
       FROM objects
       WHERE json_valid(raw)
         AND visibility IN ('public', 'unlisted')
         AND published >= datetime('now', '-7 days')
       ORDER BY published DESC
       LIMIT 500`
    )
    .all<{ id: string; actor_id: string; raw: string }>();

  const tagStats = new Map<string, { uses: number; actors: Set<string> }>();
  for (const r of rows.results) {
    let parsed: { tag?: { type?: string; name?: string }[] };
    try { parsed = JSON.parse(r.raw); } catch { continue; }
    const tags = parsed.tag ?? [];
    for (const t of tags) {
      if (t.type === "Hashtag" && t.name) {
        const name = t.name.replace(/^#/, "").toLowerCase();
        if (!name) continue;
        let stat = tagStats.get(name);
        if (!stat) {
          stat = { uses: 0, actors: new Set() };
          tagStats.set(name, stat);
        }
        stat.uses++;
        stat.actors.add(r.actor_id);
      }
    }
  }

  const sorted = [...tagStats.entries()]
    .sort((a, b) => b[1].uses - a[1].uses)
    .slice(0, limit)
    .map(([name, stat]) => serializeTag(name, domain, stat.uses, stat.actors.size));

  return json(sorted);
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
