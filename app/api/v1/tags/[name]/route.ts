import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

// Helper: deterministic numeric ID for a tag name
function tagId(name: string): string {
  let h = 5381;
  for (const c of name.toLowerCase()) {
    h = (((h << 5) + h) ^ c.charCodeAt(0)) & 0x7fffffff;
  }
  return String(h >>> 0);
}

// Build 7-day history from DB query results
function buildHistory(
  rows: { day: string; accounts: number; uses: number }[]
): { day: string; accounts: string; uses: string }[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const history: { day: string; accounts: string; uses: string }[] = [];
  const nowDaySec = Math.floor(Date.now() / 1000 / 86400) * 86400;
  for (let i = 0; i < 7; i++) {
    const daySec = String(nowDaySec - i * 86400);
    const row = byDay.get(daySec);
    history.push({
      day: daySec,
      accounts: String(row?.accounts ?? 0),
      uses: String(row?.uses ?? 0),
    });
  }
  return history;
}

// GET /api/v1/tags/:name
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const { name } = await params;
  const tagName = decodeURIComponent(name).replace(/^#/, "").toLowerCase();

  const authActor = await getAuthenticatedActor(request, env.DB);

  // Query 7-day history for this tag
  const rows = await env.DB
    .prepare(
      `SELECT
         CAST(strftime('%s', date(o.published)) AS INTEGER) AS day,
         COUNT(DISTINCT o.actor_id) AS accounts,
         COUNT(*) AS uses
       FROM objects o,
            json_each(json_extract(o.raw, '$.tag')) t
       WHERE LOWER(REPLACE(json_extract(t.value, '$.name'), '#', '')) = LOWER(?)
         AND json_extract(t.value, '$.type') = 'Hashtag'
         AND o.visibility IN ('public', 'unlisted')
         AND o.published >= datetime('now', '-7 days')
       GROUP BY day
       ORDER BY day DESC`
    )
    .bind(tagName)
    .all<{ day: number; accounts: number; uses: number }>();

  const historyRows = (rows.results ?? []).map((r) => ({
    day: String(r.day),
    accounts: r.accounts,
    uses: r.uses,
  }));

  // Determine following status if authenticated (table may not exist yet)
  let following = false;
  if (authActor) {
    try {
      const followRow = await env.DB
        .prepare(
          `SELECT 1 FROM followed_tags WHERE actor_id = ? AND tag_name = ? LIMIT 1`
        )
        .bind(authActor.id, tagName)
        .first();
      following = Boolean(followRow);
    } catch {
      // followed_tags table not yet created — treat as not following
    }
  }

  return json({
    id: tagId(tagName),
    name: tagName,
    url: `https://${domain}/tags/${encodeURIComponent(tagName)}`,
    history: buildHistory(historyRows),
    following,
  });
}
