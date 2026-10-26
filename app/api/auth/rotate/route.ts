import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor, extractBearerToken, generateSecureToken, setAuthCookie } from "@/lib/auth";
import { createOAuthToken, deleteOAuthToken, getTokenByAccessToken } from "@/lib/db";
import { env } from "cloudflare:workers";

// POST /api/auth/rotate — re-issue the web session token for an already
// authenticated session.
//
// The session cookie is HttpOnly, so page JavaScript can never read it; the
// client keeps a separate localStorage copy for the calls that cannot ride
// the cookie (WebSocket upgrades take `?access_token=`). This endpoint is how
// that copy is obtained without a re-login: an authenticated session (cookie
// or current bearer) exchanges itself for a fresh token, delivered both as
// the new cookie and in the body. Cross-site callers cannot reach it — the
// cookie is SameSite=Lax, so only same-origin pages can present a session.
export async function POST(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const presented = extractBearerToken(request);
  const accessToken = generateSecureToken();
  const refreshToken = generateSecureToken();
  const now = Date.now();
  const expiresAt = new Date(now + 30 * 24 * 3600 * 1000).toISOString();

  await createOAuthToken(env.DB, {
    id: crypto.randomUUID(),
    appId: null,
    actorId: actor.id,
    accessToken,
    refreshToken,
    scope: "read write follow push",
    expiresAt,
    createdAt: new Date(now).toISOString(),
  });

  // Retire the presented token so rotating does not accumulate parallel
  // sessions (best effort: the old token also expires on its own).
  if (presented && presented !== accessToken) {
    const old = await getTokenByAccessToken(env.DB, presented).catch(() => null);
    if (old) await deleteOAuthToken(env.DB, old.id).catch(() => {});
  }

  return json(
    { access_token: accessToken, token_type: "Bearer", expires_at: expiresAt },
    200,
    { "Set-Cookie": setAuthCookie(accessToken) }
  );
}
