import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { extractBearerToken } from "@/lib/auth";
import { getTokenByAccessToken, getActorById } from "@/lib/db";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const token = extractBearerToken(request);
  if (!token) return json({ authenticated: false }, 200);

  const tokenRow = await getTokenByAccessToken(env.DB, token);
  if (!tokenRow || !tokenRow.actorId) return json({ authenticated: false }, 200);
  if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) return json({ authenticated: false }, 200);

  const actor = await getActorById(env.DB, tokenRow.actorId);
  if (!actor) return json({ authenticated: false }, 200);

  return json({
    authenticated: true,
    actor: {
      id: actor.id,
      username: actor.username,
      displayName: actor.displayName,
    },
  });
}
