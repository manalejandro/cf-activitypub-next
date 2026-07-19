import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { name } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const tagName = decodeURIComponent(name).toLowerCase().replace(/^#/, "");
  const { createFeaturedTag } = await import("@/lib/db");
  await createFeaturedTag(env.DB, crypto.randomUUID(), me.id, tagName);
  return json({
    id: crypto.randomUUID(),
    name: tagName,
    url: "",
    statuses_count: 0,
    last_status_at: null,
    history: [],
  });
}
