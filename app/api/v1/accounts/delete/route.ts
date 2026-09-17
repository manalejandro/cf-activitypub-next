import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor, clearAuthCookie } from "@/lib/auth";
import { countUsableAdmins, getActorById } from "@/lib/db";
import { buildDelete, generateId } from "@/lib/activitypub/utils";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { recordModeration } from "@/lib/moderation/log";
import type { APActor } from "@/lib/types";

// POST /api/v1/accounts/delete — permanently delete the current account.
// Removes the actor and all cascade-dependent data, federates a Delete
// tombstone to followers, revokes every session token and clears the cookie.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
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

  // Federate a Delete(actor) tombstone before the actor row disappears.
  if (env.DELIVERY_QUEUE) {
    const deleteActivity = buildDelete(baseUrl, actor.id, actor.id, generateId());
    const followers = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ actor_id: string }>();
    const fetchActor = async (id: string): Promise<APActor | null> => {
      const cached = await getActorById(env.DB, id);
      return cached as unknown as APActor | null;
    };
    const inboxes = await collectFollowerInboxes(followers.results.map((r) => r.actor_id), fetchActor);
    if (inboxes.length > 0) {
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(deleteActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
    }
  }

  // Sessions + audit trail reference the actor without an FK, so clear them
  // explicitly before the cascading actor delete.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_tokens WHERE actor_id = ?").bind(actor.id),
    env.DB.prepare("DELETE FROM activities WHERE actor_id = ?").bind(actor.id),
    env.DB.prepare("DELETE FROM moderation_log WHERE target_id = ?").bind(actor.id),
    env.DB.prepare("DELETE FROM actors WHERE id = ?").bind(actor.id),
  ]);

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: actor.id,
    action: "deleted",
    reason: "Account deleted by its owner.",
    confidence: null,
    model: "user",
    details: { username: actor.username, domain: actor.domain },
    emailSent: false,
    emailTo: actor.email,
    relatedId: null,
  });

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAuthCookie(),
    },
  });
}