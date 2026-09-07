import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorById, getAllCustomEmojis, getLastStatusAt } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  if (!q.trim()) return json([]);

  // Prefix match on username (autocomplete), substring on display name. When the
  // query is a remote handle (`user@domain`) also match the domain. Local
  // accounts rank first, then cached remote ones by popularity. Suspended
  // accounts are never suggested.
  const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");
  const likeUsername = `${escapeLike(q)}%`;
  const likeDisplay = `%${escapeLike(q)}%`;
  const atIdx = q.indexOf("@");
  const userPart = atIdx > 0 ? q.slice(0, atIdx) : "";
  const domainPart = atIdx >= 0 ? q.slice(atIdx + 1) : "";

  let sql = `SELECT * FROM actors WHERE suspended = 0 AND (`;
  const params: string[] = [];
  if (userPart && domainPart) {
    sql += `(username LIKE ? ESCAPE '\\' AND domain LIKE ? ESCAPE '\\') OR `;
    params.push(`${escapeLike(userPart)}%`, `${escapeLike(domainPart)}%`);
  }
  sql += `(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'))
    ORDER BY is_local DESC, followers_count DESC
    LIMIT ?`;
  params.push(likeUsername, likeDisplay, String(limit));

  const rows = await env.DB
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  const emojis = await getAllCustomEmojis(env.DB);
  const results = await Promise.all(
    rows.results.map(async (r) => {
      const actor = await getActorById(env.DB, r.id as string);
      if (!actor) return null;
      const lastStatusAt = await getLastStatusAt(env.DB, actor.id);
      return serializeAccount(actor, domain, { emojis, lastStatusAt });
    })
  );
  return json(results.filter(Boolean));
}
