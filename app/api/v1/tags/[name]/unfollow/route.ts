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

// POST /api/v1/tags/:name/unfollow
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const { name } = await params;
  const tagName = decodeURIComponent(name).replace(/^#/, "").toLowerCase();

  const authActor = await getAuthenticatedActor(request, env.DB);
  if (!authActor) return unauthorized();

  try {
    await env.DB
      .prepare(`DELETE FROM followed_tags WHERE actor_id = ? AND tag_name = ?`)
      .bind(authActor.id, tagName)
      .run();
  } catch {
    // Table not yet created — silently succeed
  }

  return json({
    id: tagId(tagName),
    name: tagName,
    url: `https://${domain}/tags/${encodeURIComponent(tagName)}`,
    history: [],
    following: false,
  });
}
