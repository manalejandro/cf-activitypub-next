import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, getFollowing, getLastStatusAt } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/accounts/:id/following
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const rawId = decodeURIComponent(id);

  const actor = await getActorById(env.DB, rawId);
  if (!actor) return notFound("Account not found");

  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.pageSize));
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "0");
  const following = await getFollowing(env.DB, actor.id, Math.min(limit, limits.maxPageSize), page * limit);

  const result = await Promise.all(
    following.map(async (f) => {
      const lastStatusAt = await getLastStatusAt(env.DB, f.id);
      return serializeAccount(f, domain, { lastStatusAt });
    })
  );
  return json(result);
}
