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

  // Extract hashtag names from the AP raw JSON stored in objects.
  // The 'tag' array in each Note looks like: [{"type":"Hashtag","name":"#foo","href":"..."}]
  const rows = await env.DB
    .prepare(
      `SELECT
         LOWER(REPLACE(json_extract(t.value, '$.name'), '#', '')) AS tag_name,
         COUNT(DISTINCT o.actor_id) AS accounts,
         COUNT(*) AS uses
       FROM objects o,
            json_each(json_extract(o.raw, '$.tag')) t
       WHERE json_extract(t.value, '$.type') = 'Hashtag'
         AND json_extract(t.value, '$.name') IS NOT NULL
         AND o.visibility IN ('public', 'unlisted')
         AND o.published >= datetime('now', '-7 days')
       GROUP BY tag_name
       ORDER BY uses DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ tag_name: string; accounts: number; uses: number }>();

  const tags = (rows.results ?? [])
    .filter((r) => r.tag_name && r.tag_name.length > 0)
    .map((r) => serializeTag(r.tag_name, domain, r.uses, r.accounts));

  return json(tags);
}

function tagId(name: string): string {
  // Deterministic ID derived from tag name via DJB2 hash.
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
