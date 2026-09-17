import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, countUsableAdmins } from "@/lib/db";
import { getAdminRole } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

/**
 * POST /api/v1/admin/accounts/:id/reject — deny a pending registration and
 * remove the account. Full-admin only, never the reserved actor nor the last
 * usable administrator, and only for accounts that are still unverified or
 * unapproved (established accounts must go through the audited delete flow).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();
  if (actor.reserved) return json({ error: "The instance actor cannot be modified" }, 422);
  if (actor.role === "admin" && (await countUsableAdmins(env.DB, id)) === 0) {
    return json({ error: "Cannot remove the last administrator's access" }, 422);
  }
  if (actor.approved !== false && actor.emailVerified) {
    return json({ error: "Only pending registrations can be rejected — use DELETE for established accounts" }, 422);
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_tokens WHERE actor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM activities WHERE actor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM moderation_log WHERE target_id = ?").bind(id),
    env.DB.prepare("DELETE FROM actors WHERE id = ?").bind(id),
  ]);

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: id,
    action: "rejected",
    reason: "Registration rejected by an administrator.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({});
}
