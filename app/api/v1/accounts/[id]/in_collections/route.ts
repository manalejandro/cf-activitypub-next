import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, listCollectionsFeaturedIn } from "@/lib/db";
import { serializeCollection } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/accounts/:account_id/in_collections — all Collections the account
// is featured in.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const accountId = decodeURIComponent(id);
  const actor = await getActorById(env.DB, accountId);
  if (!actor) return notFound("Account not found");

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.pageSize)), limits.maxCollectionPage);
  const offset = Math.max(parseInt(request.nextUrl.searchParams.get("offset") ?? "0"), 0);

  const collections = await listCollectionsFeaturedIn(env.DB, actor.id, { limit, offset });

  return json({ collections: collections.map((c) => serializeCollection(c, domain)) });
}
