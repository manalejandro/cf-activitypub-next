import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFeaturedTags, deleteFeaturedTag } from "@/lib/db";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { name } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const tagName = decodeURIComponent(name).toLowerCase().replace(/^#/, "");
  const tags = await getFeaturedTags(env.DB, me.id);
  const match = tags.find((t) => t.tag_name === tagName);
  if (match) await deleteFeaturedTag(env.DB, match.id);
  return json({});
}
