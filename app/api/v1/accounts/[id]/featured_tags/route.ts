import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorById, getFeaturedTags } from "@/lib/db";
import { env } from "cloudflare:workers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const actor = await getActorById(env.DB, rawId);
  if (!actor) return notFound();
  const tags = await getFeaturedTags(env.DB, rawId);
  return json(tags.map((t) => ({
    id: t.id,
    name: t.tag_name,
    created_at: t.created_at,
    statuses_count: 0,
    last_status_at: null,
  })));
}
