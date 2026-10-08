import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { extractBearerToken } from "@/lib/auth";
import { getTokenByAccessToken, getActorById } from "@/lib/db";
import { env } from "cloudflare:workers";

// GET /api/auth/status — session probe for the web client.
//
// When a token is present but the session is unusable, the response carries a
// `reason` so the client can bounce the visitor to the landing page instead of
// leaving them in a broken app shell:
//   - "suspended": the account was suspended by moderation
//   - "deleted":   the actor no longer exists (deleted or rejected)
//   - "invalid":   unknown or expired token
//   - "unverified" / "pending": registration gates (email / admin approval)
export async function GET(request: NextRequest): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) return json({ authenticated: false }, 200);

  const tokenRow = await getTokenByAccessToken(env.DB, token);
  if (!tokenRow || !tokenRow.actorId) return json({ authenticated: false, reason: "invalid" }, 200);
  if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) {
    return json({ authenticated: false, reason: "invalid" }, 200);
  }

  const actor = await getActorById(env.DB, tokenRow.actorId);
  if (!actor) return json({ authenticated: false, reason: "deleted" }, 200);
  // Mirror getAuthenticatedActor: a suspended, unconfirmed or pending-approval
  // account is not authenticated, whatever token it holds.
  if (actor.suspended) return json({ authenticated: false, reason: "suspended" }, 200);
  if (actor.isLocal && !actor.emailVerified) return json({ authenticated: false, reason: "unverified" }, 200);
  if (actor.isLocal && actor.approved === false) return json({ authenticated: false, reason: "pending" }, 200);

  return json({
    authenticated: true,
    actor: {
      id: actor.id,
      username: actor.username,
      displayName: actor.displayName,
    },
  });
}
