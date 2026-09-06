import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getFollowers } from "@/lib/db";
import { actorIRI, buildOrderedCollection, buildOrderedCollectionPage } from "@/lib/activitypub/utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  // Remote instances fetch this collection when resolving accounts; cache in
  // KV so a burst of resolutions doesn't hammer D1.
  const pageParam = request.nextUrl.searchParams.get("page");
  const cacheKey = `ap:followers:${username.toLowerCase()}${pageParam ? `:${pageParam.slice(0, 40)}` : ""}`;
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return activityJson(JSON.parse(cached) as Record<string, unknown>);
  }

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  let response: Record<string, unknown>;
  const collectionId = `${actorIRI(baseUrl, username)}/followers`;
  const page = request.nextUrl.searchParams.get("page");

  if (!page) {
    response = buildOrderedCollection(collectionId, actor.followersCount);
  } else {
    const pageNum = page === "true" ? 0 : parseInt(page) || 0;
    const followers = await getFollowers(env.DB, actor.id, 40, pageNum * 40);
    const items = followers.map((f) => f.id);

    response = buildOrderedCollectionPage(
      collectionId,
      items,
      followers.length === 40 ? `${collectionId}?page=${pageNum + 1}` : undefined
    );
  }

  await env.KV.put(cacheKey, JSON.stringify(response), { expirationTtl: 120 }).catch(() => {});
  return activityJson(response);
}
