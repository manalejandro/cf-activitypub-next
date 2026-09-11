import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getCollectionById, getCollectionItems } from "@/lib/db";
import { buildFeaturedCollection } from "@/lib/activitypub/collections";

// GET /users/:username/collections/:id — a single FeaturedCollection object
// (FEP-7aa9), as referenced by its `id` in the actor's collections listing.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string; id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username, id } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const collection = await getCollectionById(env.DB, id);
  if (!collection || collection.account_id !== actor.id || !collection.discoverable) {
    return notFound("Collection not found");
  }

  const items = (await getCollectionItems(env.DB, collection.id)).filter((i) => i.state === "accepted");
  return activityJson(buildFeaturedCollection(baseUrl, actor.username, collection, items));
}
