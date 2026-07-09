import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getMutedActorIds, getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "40"), 80);
  const mutedIds = await getMutedActorIds(env.DB, actor.id);
  const sliced = mutedIds.slice(0, limit);

  const accounts = await Promise.all(
    sliced.map(async (id) => {
      const a = await getActorById(env.DB, id);
      return a ? serializeAccount(a, domain) : null;
    })
  );

  return json(accounts.filter(Boolean));
}
