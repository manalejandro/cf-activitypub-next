import { type NextRequest } from "next/server";
import { json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, createBlock } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { generateId } from "@/lib/activitypub/utils";
import { buildRelationship } from "@/lib/mastodon/relationships";
import { env } from "cloudflare:workers";

// POST /api/v1/accounts/:id/block
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const rawId = decodeURIComponent(id);
  let target = await getActorById(env.DB, rawId);
  if (!target && rawId.startsWith("https://")) {
    const cached = await fetchAndCacheRemoteActor(env.DB, rawId, env.KV);
    if (cached) target = await getActorById(env.DB, cached.id);
  }
  if (!target) return notFound("Account not found");

  await createBlock(env.DB, generateId(), actor.id, target.id);

  return json(await buildRelationship(env.DB, actor.id, target.id));
}
