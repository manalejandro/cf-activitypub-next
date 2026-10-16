import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { accountActionGuard } from "@/lib/admin/account-guards";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastActorState } from "@/lib/activitypub/actor-update";
import { learnFromSuspension } from "@/lib/moderation/learn";
import { env } from "cloudflare:workers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  const denied = await accountActionGuard(request, env, actor, { removesAccess: true });
  if (denied) return denied;

  await env.DB
    .prepare("UPDATE actors SET suspended = 1, suspended_at = COALESCE(suspended_at, ?), updated_at = datetime('now') WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();

  // Federate the change: peers only re-read the actor document on a refetch
  // (Mastodon's `SuspendAccountService#distribute_update_actor`).
  await broadcastActorState(env, id).catch(() => {});

  // A moderator's suspension is a confirmed abuse decision: the Guardian
  // remembers the account (its posts and profile) so its next incarnation is
  // caught without a fresh model call.
  const lesson = await learnFromSuspension(env, {
    actorId: id,
    reason: "Account suspended by an administrator.",
    model: "admin",
  });

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: id,
    action: "suspended",
    reason: "Account suspended by an administrator.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain, learned: lesson },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ id, suspended: true });
}
