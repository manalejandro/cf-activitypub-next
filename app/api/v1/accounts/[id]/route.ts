import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, getActorStatuses, getFollow, getActorFields } from "@/lib/db";
import { serializeAccount, serializeStatus } from "@/lib/mastodon/serializers";
import { getAuthenticatedActor } from "@/lib/auth";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";

// GET /api/v1/accounts/:id
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const rawId = decodeURIComponent(id);

  let actor = await getActorById(env.DB, rawId);

  // For remote actors: always re-fetch from source to get up-to-date counts.
  // For actors not yet in DB: fetch and cache first.
  if (rawId.startsWith("https://")) {
    const refreshed = await fetchAndCacheRemoteActor(env.DB, rawId);
    if (refreshed) {
      actor = await getActorById(env.DB, refreshed.id) ?? actor;
    }
  }

  if (!actor) return notFound("Account not found");

  const fields = await getActorFields(env.DB, actor.id);
  return json(serializeAccount(actor, domain, { fields }));
}
