import { type NextRequest } from "next/server";
import { activityJson, getBaseUrl, notFound } from "@/lib/cf";
import { getActorByUsername, getFeaturedTags } from "@/lib/db";
import { DEFAULT_CONTEXT } from "@/lib/activitypub/vocab";
import { env } from "cloudflare:workers";

// GET /users/:username/collections/tags — the account's featured hashtags.
// Mastodon advertises it as the actor's `featuredTags` and sends it as the
// `target` of the `Add`/`Remove` for a featured tag; the items are Hashtag
// objects (ActivityPub::HashtagSerializer), not plain strings.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  // The collection id must match what the actor document advertises
  // (buildActor builds it from the canonical instance URL, never the Host).
  const baseUrl = getBaseUrl(env);

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const tags = await getFeaturedTags(env.DB, actor.id);
  const items = tags.map((tag) => ({
    type: "Hashtag",
    href: `${baseUrl}/tags/${tag.tag_name}`,
    name: `#${tag.tag_name}`,
  }));

  return activityJson(
    {
      "@context": DEFAULT_CONTEXT,
      id: `${baseUrl}/users/${actor.username}/collections/tags`,
      type: "Collection",
      totalItems: items.length,
      items,
    },
    200,
    { "Cache-Control": "public, max-age=180" }
  );
}
