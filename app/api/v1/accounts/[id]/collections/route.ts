import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, listCollectionsForAccount } from "@/lib/db";
import { serializeCollection } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";
import { syncRemoteCollections } from "@/lib/activitypub/collections";

// GET /api/v1/accounts/:account_id/collections — all Collections from an account.
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

  // Remote profiles: fetch and cache their FEP-7aa9 collections (throttled to
  // once an hour per actor) so the profile's Collections tab and search work.
  if (!actor.isLocal) {
    await syncRemoteCollections(env.DB, env.KV, actor.id);
  }

  const me = await getAuthenticatedActor(request, env.DB);
  const isOwner = me !== null && me.id === actor.id;

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.pageSize)), limits.maxCollectionPage);
  const offset = Math.max(parseInt(request.nextUrl.searchParams.get("offset") ?? "0"), 0);

  const collections = await listCollectionsForAccount(env.DB, actor.id, {
    discoverableOnly: !isOwner,
    limit,
    offset,
  });

  return json({ collections: collections.map((c) => serializeCollection(c, domain)) });
}
