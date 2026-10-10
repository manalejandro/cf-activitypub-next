import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { requireFullAdmin } from "@/lib/admin-auth";
import { accountActionGuard } from "@/lib/admin/account-guards";
import { notifyAccountOwner } from "@/lib/moderation/actions";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { env } from "cloudflare:workers";

/**
 * POST /api/v1/admin/accounts/:id/memorialize — preserve an account "in
 * memoriam" (Mastodon's `Account#memorialize!`): the profile and posts stay,
 * the account can no longer sign in, it leaves the suggestions and the actor
 * document advertises `memorial: true` so peers render the badge.
 *
 * Full administrators only (Mastodon requires the `delete_user_data` role
 * permission), and only local accounts.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await requireFullAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor || !actor.isLocal) return notFound();

  // Memorializing removes the account's login access, so the same guard as
  // suspension applies (no self-actions, no reserved actor, admins need a full
  // admin, the last administrator cannot lose access).
  const denied = await accountActionGuard(request, env, actor, { removesAccess: true });
  if (denied) return denied;

  if (actor.memorial) return json({ id, memorial: true });

  await env.DB
    .prepare("UPDATE actors SET memorial = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();

  // Drop the cached federated actor so a peer fetching the document sees the
  // new state (Mastodon does not distribute an Update for a memorialization).
  await env.KV.delete(`ap:actor:${actor.username.toLowerCase()}`).catch(() => {});

  const emailSent = await notifyAccountOwner(env, actor, "memorial", "La cuenta se conserva en memoria.");

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: id,
    action: "memorialized",
    reason: "Account memorialized by an administrator.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain },
    emailSent,
    emailTo: actor.email,
    relatedId: null,
  });

  return json({ id, memorial: true });
}
