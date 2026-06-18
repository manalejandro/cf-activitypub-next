import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername } from "@/lib/db";
import { AS_CONTEXT } from "@/lib/activitypub/vocab";

// GET /users/:username/collections/tags
// Returns the actor's featured hashtags collection.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  const actorId = `https://${domain}/users/${actor.username}`;

  return activityJson({
    "@context": AS_CONTEXT,
    id: `${actorId}/collections/tags`,
    type: "Collection",
    totalItems: 0,
    items: [],
  });
}
