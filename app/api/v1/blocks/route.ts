import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getBlockedActors } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeAccount } from "@/lib/mastodon/serializers";

// GET /api/v1/blocks
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 80);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const blocked = await getBlockedActors(env.DB, actor.id, limit, offset);
  return json(blocked.map((a) => serializeAccount(a, domain)));
}
