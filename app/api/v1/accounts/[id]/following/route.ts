import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, getFollowing } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

// GET /api/v1/accounts/:id/following
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const rawId = decodeURIComponent(id);

  const actor = await getActorById(env.DB, rawId);
  if (!actor) return notFound("Account not found");

  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "40");
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "0");
  const following = await getFollowing(env.DB, actor.id, Math.min(limit, 80), page * limit);

  return json(following.map((f) => serializeAccount(f, domain)));
}
