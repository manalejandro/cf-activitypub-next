import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor, clearAuthCookie } from "@/lib/auth";
import { countUsableAdmins } from "@/lib/db";
import { deleteLocalAccount } from "@/lib/account-deletion";
import { env } from "cloudflare:workers";

// POST /api/v1/accounts/delete — permanently delete the current account.
// Removes the actor and all cascade-dependent data, federates a Delete
// tombstone to followers, revokes every session token and clears the cookie.
export async function POST(request: NextRequest): Promise<Response> {
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();
  if (!actor.privateKeyPem) return json({ error: "Account has no private key" }, 500);
  // The instance must keep a reachable administrator (the reserved Guardian
  // actor has no credentials and does not count).
  if (actor.role === "admin" && (await countUsableAdmins(env.DB, actor.id)) === 0) {
    return json({ error: "The last administrator cannot delete their account" }, 422);
  }

  await deleteLocalAccount(env, actor, {
    baseUrl,
    reason: "Account deleted by its owner.",
    source: "user",
  });

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAuthCookie(),
    },
  });
}