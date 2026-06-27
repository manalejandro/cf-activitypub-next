import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

// Helper: deterministic numeric ID for a tag name
function tagId(name: string): string {
  let h = 5381;
  for (const c of name.toLowerCase()) {
    h = (((h << 5) + h) ^ c.charCodeAt(0)) & 0x7fffffff;
  }
  return String(h >>> 0);
}

// GET /api/v1/followed_tags
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const authActor = await getAuthenticatedActor(request, env.DB);
  if (!authActor) return unauthorized();

  try {
    const rows = await env.DB
      .prepare(
        `SELECT tag_name FROM followed_tags WHERE actor_id = ? ORDER BY created_at DESC`
      )
      .bind(authActor.id)
      .all<{ tag_name: string }>();

    const tags = (rows.results ?? []).map((r) => ({
      id: tagId(r.tag_name),
      name: r.tag_name,
      url: `https://${domain}/tags/${encodeURIComponent(r.tag_name)}`,
      history: [],
      following: true,
    }));

    return json(tags);
  } catch {
    // followed_tags table not yet created
    return json([]);
  }
}
