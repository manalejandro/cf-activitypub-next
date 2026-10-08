import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor, extractBearerToken } from "@/lib/auth";
import { listOAuthTokensForActor, getTokenByAccessToken } from "@/lib/db";
import { env } from "cloudflare:workers";

// GET /api/oauth/authorized — list the authenticated user's app connections
// and web sessions (Mastodon "Authorized apps"). Never exposes access tokens.
export async function GET(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const currentToken = extractBearerToken(request) ?? "";
  const currentTokenRow = currentToken ? await getTokenByAccessToken(env.DB, currentToken) : null;
  const connections = await listOAuthTokensForActor(env.DB, actor.id);

  return json({
    connections: connections.map((c) => ({
      id: c.id,
      appName: c.appName,
      appWebsite: c.appWebsite,
      scope: c.scope,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      isWebSession: c.appId === null,
      isCurrent: currentTokenRow !== null && c.id === currentTokenRow.id,
    })),
  });
}