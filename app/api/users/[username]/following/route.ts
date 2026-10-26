import { type NextRequest } from "next/server";
import { activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getFollowing } from "@/lib/db";
import { actorIRI, buildOrderedCollection, buildOrderedCollectionPage } from "@/lib/activitypub/utils";
import { MAX_AP_COLLECTION_PAGE } from "@/lib/constants";
import { env } from "cloudflare:workers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  // Remote instances fetch this collection when resolving accounts; cache in
  // KV so a burst of resolutions doesn't hammer D1. Only shallow pages are
  // cached: `page` is client-controlled, and caching every value would let a
  // caller mint unbounded KV keys (write-quota flooding) that never re-hit.
  const pageParam = request.nextUrl.searchParams.get("page");
  const pageNum = pageParam
    ? pageParam === "true"
      ? 0
      : Math.min(Math.max(0, Number.parseInt(pageParam, 10) || 0), MAX_AP_COLLECTION_PAGE)
    : null;
  const cacheable = pageNum === null || pageNum <= 10;
  const cacheKey = `ap:following:${username.toLowerCase()}${pageNum !== null ? `:${pageNum}` : ""}`;
  if (cacheable) {
    const cached = await env.KV.get(cacheKey).catch(() => null);
    if (cached) {
      return activityJson(JSON.parse(cached) as Record<string, unknown>);
    }
  }

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const collectionId = `${actorIRI(baseUrl, username)}/following`;

  let response: Record<string, unknown>;
  if (pageNum === null) {
    response = buildOrderedCollection(collectionId, actor.followingCount);
  } else {
    const following = await getFollowing(env.DB, actor.id, 40, pageNum * 40);
    const items = following.map((f) => f.id);

    response = buildOrderedCollectionPage(
      collectionId,
      `${collectionId}?page=${pageNum}`,
      items,
      following.length === 40 ? `${collectionId}?page=${pageNum + 1}` : undefined
    );
  }

  if (cacheable) {
    await env.KV.put(cacheKey, JSON.stringify(response), { expirationTtl: 120 }).catch(() => {});
  }
  return activityJson(response);
}