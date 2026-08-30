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
  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const rows = await env.DB
    .prepare(
      `SELECT * FROM actors
       WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
         AND is_local = 1
       LIMIT ?`
    )
    .bind(like, like, limit)
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
