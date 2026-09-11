import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, listCollectionsForAccount, getCollectionItems, countCollectionsForAccount } from "@/lib/db";
import { buildFeaturedCollection } from "@/lib/activitypub/collections";
import { DEFAULT_CONTEXT } from "@/lib/activitypub/vocab";

const PAGE_SIZE = 20;

// GET /users/:username/collections — FEP-7aa9 listing of the actor's public
// FeaturedCollection objects (the actor advertises this URL as
// `featuredCollections`). Paginated like any AS Collection.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const listingId = `${baseUrl}/users/${actor.username}/collections`;
  const pageParam = request.nextUrl.searchParams.get("page");
  const total = await countCollectionsForAccount(env.DB, actor.id, true);

  if (!pageParam) {
    return activityJson({
      "@context": DEFAULT_CONTEXT,
      id: listingId,
      type: "Collection",
      totalItems: total,
      first: `${listingId}?page=1`,
    });
  }

  const page = Math.max(parseInt(pageParam) || 1, 1);
  const collections = await listCollectionsForAccount(env.DB, actor.id, {
    discoverableOnly: true,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const orderedItems = [];
  for (const col of collections) {
    const items = (await getCollectionItems(env.DB, col.id)).filter((i) => i.state === "accepted");
    orderedItems.push(buildFeaturedCollection(baseUrl, actor.username, col, items));
  }

  return activityJson({
    "@context": DEFAULT_CONTEXT,
    id: `${listingId}?page=${page}`,
    type: "CollectionPage",
    partOf: listingId,
    totalItems: total,
    orderedItems,
    ...(collections.length === PAGE_SIZE ? { next: `${listingId}?page=${page + 1}` } : {}),
    ...(page > 1 ? { prev: `${listingId}?page=${page - 1}` } : {}),
  });
}
