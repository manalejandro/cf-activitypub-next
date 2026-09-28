import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { accountActionGuard } from "@/lib/admin/account-guards";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

/**
 * POST /api/v1/admin/accounts/:id/reject — deny a pending registration and
 * remove the account.
 *
 * Moderation action (a moderator may accept sign-ups, so they may reject them
 * too): the shared guard blocks the reserved actor, self-actions, administrator
 * targets and removing the last administrator's access. Only accounts that are
 * still unverified or unapproved qualify — established accounts must go
 * through the audited delete flow.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();
  const denied = await accountActionGuard(request, env, actor, { removesAccess: true });
  if (denied) return denied;
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
