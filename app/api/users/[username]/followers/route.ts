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

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  const collectionId = `${actorIRI(baseUrl, username)}/followers`;
  const page = request.nextUrl.searchParams.get("page");

  if (!page) {
    return activityJson(buildOrderedCollection(collectionId, actor.followersCount));
  }

  const pageNum = page === "true" ? 0 : parseInt(page) || 0;
  const followers = await getFollowers(env.DB, actor.id, 40, pageNum * 40);
  const items = followers.map((f) => f.id);

  return activityJson(
    buildOrderedCollectionPage(
      collectionId,
      items,
      followers.length === 40 ? `${collectionId}?page=${pageNum + 1}` : undefined
    )
  );
}
