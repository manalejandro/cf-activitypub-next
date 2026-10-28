import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { accountActionGuard } from "@/lib/admin/account-guards";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastActorState } from "@/lib/activitypub/actor-update";
import { learnFromSuspension, type SuspensionLessonResult } from "@/lib/moderation/learn";
import { broadcastAccountUpdate } from "@/lib/streaming/broadcast";
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
    .prepare(
      `UPDATE actors SET suspended = 1, suspension_origin = 'local',
         suspended_at = COALESCE(suspended_at, ?), updated_at = datetime('now') WHERE id = ?`
    )
    .bind(new Date().toISOString(), id)
    .run();

  // Federate the change: peers only re-read the actor document on a refetch
  // (Mastodon's `SuspendAccountService#distribute_update_actor`).
  await broadcastActorState(env, id).catch(() => {});
  // Drop the cached actor document: the broadcast pushes the new state, but a
  // peer that PULLS `/users/:username` within the 5-min cache TTL would
  // otherwise be served the pre-suspension copy (still `suspended: false`).
  await env.KV.delete(`ap:actor:${actor.username.toLowerCase()}`).catch(() => {});
  // Local clients: cached feeds keep rendering the account's posts until they
  // are told to drop them — a remote account gets no AP broadcast at all.
  await broadcastAccountUpdate(env.TIMELINE_STREAM, env.DB, { actorId: id, suspended: true, local: actor.isLocal }).catch(() => {});

  // A moderator's suspension is a confirmed abuse decision: the Guardian
  // remembers the account (its posts and profile) so its next incarnation is
  // caught without a fresh model call. Best-effort: `learnFromSuspension`
  // never throws, and the audit entry below must not depend on it either (this
  // route once applied a suspension and lost the entry when the vector call
  // failed — the account stayed suspended with no trace).
  let lesson: SuspensionLessonResult | null = null;
  try {
    lesson = await learnFromSuspension(env, {
      actorId: id,
      reason: "Account suspended by an administrator.",
      model: "admin",
    });
  } catch { /* the audit entry records learned: null */ }

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
