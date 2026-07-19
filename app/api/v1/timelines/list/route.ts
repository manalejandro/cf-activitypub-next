import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const listId = request.nextUrl.searchParams.get("list_id") ?? "";
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "20"), 40);
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const rows = await env.DB
    .prepare(
      `SELECT o.* FROM objects o
       JOIN list_accounts la ON la.actor_id = o.actor_id
       WHERE la.list_id = ?
         AND o.visibility IN ('public', 'unlisted')
       ORDER BY o.published DESC
       LIMIT ?`
    )
    .bind(listId, limit)
    .all<Record<string, unknown>>();
  if (rows.results.length === 0) return json([]);
  const { getActorById, getAttachmentsByObjectIds, getAllCustomEmojis } = await import("@/lib/db");
  const { serializeStatus } = await import("@/lib/mastodon/serializers");
  const objectIds = rows.results.map((r) => r.id as string);
  const [attachmentMap, allEmojis] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objectIds),
    getAllCustomEmojis(env.DB),
  ]);
  const statuses = await Promise.all(
    rows.results.map(async (r) => {
      const author = await getActorById(env.DB, r.actor_id as string);
      if (!author) return null;
      const obj = {
        id: r.id as string,
        type: r.type as string,
        actorId: r.actor_id as string,
        content: r.content as string | null,
        contentWarning: r.content_warning as string | null,
        sensitive: Boolean(r.sensitive),
        visibility: r.visibility as "public" | "unlisted" | "followers" | "direct",
        inReplyToId: r.in_reply_to_id as string | null,
        language: r.language as string | null,
        url: r.url as string,
        repliesCount: Number(r.replies_count ?? 0),
        reblogsCount: Number(r.reblogs_count ?? 0),
        favouritesCount: Number(r.favourites_count ?? 0),
        published: r.published as string,
        updatedAt: r.updated_at as string,
        local: Boolean(r.is_local),
        raw: r.raw as string,
      };
      return serializeStatus(obj, author, domain, { attachments: attachmentMap.get(obj.id) ?? [], emojis: allEmojis });
    })
  );
  return json(statuses.filter(Boolean));
}
