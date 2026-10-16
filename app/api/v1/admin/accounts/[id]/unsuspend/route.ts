import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { accountActionGuard } from "@/lib/admin/account-guards";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastActorState } from "@/lib/activitypub/actor-update";
import { forgetSuspension } from "@/lib/moderation/learn";
import { env } from "cloudflare:workers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  // Lifting a suspension is a restoration: allowed even on the reserved actor,
  // whose state nothing else may change.
  const denied = await accountActionGuard(request, env, actor, { removesAccess: false, restores: true });
  if (denied) return denied;

  await env.DB
    .prepare("UPDATE actors SET suspended = 0, suspended_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();

  // Federate the change: peers only re-read the actor document on a refetch
  // (Mastodon's `SuspendAccountService#distribute_update_actor`).
  await broadcastActorState(env, id).catch(() => {});

  // Lifting the suspension corrects the record: the Guardian forgets the
  // lesson, or a mistaken suspension keeps matching new content.
  const forgotten = await forgetSuspension(env, id);

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: id,
    action: "unsuspended",
    reason: "Account suspension lifted by an administrator.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain, forgotten },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ id, suspended: false });
}
