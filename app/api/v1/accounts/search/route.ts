import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "20"), 40);
  const resolve = request.nextUrl.searchParams.get("resolve") === "true";
  if (!q.trim()) return json([]);
  const me = await getAuthenticatedActor(request, env.DB);
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
      return actor ? serializeAccount(actor, domain, { emojis }) : null;
    })
  );
  return json(results.filter(Boolean));
}
