import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { buildRelationship } from "@/lib/mastodon/relationships";
import { env } from "cloudflare:workers";

// GET /api/v1/accounts/relationships?id[]=xxx&id[]=yyy
// Used by Mastodon clients to display the follow/block/mute state for one or more accounts.
export async function GET(request: NextRequest): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  // Mastodon sends either id[]=... (array) or id=... (single)
  const ids = [
    ...request.nextUrl.searchParams.getAll("id[]"),
    ...request.nextUrl.searchParams.getAll("id"),
  ].filter(Boolean);

  const relationships = await Promise.all(
    ids.map(async (id) => buildRelationship(env.DB, actor.id, decodeURIComponent(id)))
  );

  return json(relationships);
}