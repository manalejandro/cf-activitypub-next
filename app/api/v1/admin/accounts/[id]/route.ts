import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, setActorApproval } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { requireAdmin } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { buildDelete, generateId } from "@/lib/activitypub/utils";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { sendWelcomeEmail } from "@/lib/email";
import type { APActor } from "@/lib/types";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;

  let row: Record<string, unknown> | null = null;
  try {
    row = await env.DB.prepare("SELECT * FROM actors WHERE id = ?").bind(id).first<Record<string, unknown>>();
  } catch { /* missing columns — run migration */ }
  if (!row?.id) return notFound();

  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  return json({
    id: actor.id,
    username: actor.username,
    domain: actor.domain,
    created_at: actor.createdAt,
    email: actor.email,
    ip: null,
    role: { id: row.role === "admin" ? "1" : row.role === "moderator" ? "2" : "3", name: row.role === "admin" ? "Admin" : row.role === "moderator" ? "Moderator" : "User", color: "" },
    confirmed: actor.emailVerified,
    suspended: Boolean(row.suspended),
    silenced: Boolean(row.silenced),
    disabled: false,
    approved: row.approved !== undefined ? Boolean(row.approved) : true,
    registration_reason: row.registration_reason ?? null,
    account: serializeAccount(actor, domain),
  });
}

/**
 * PATCH /api/v1/admin/accounts/:id — registration approval workflow.
 * Body: { action: "approve" | "unapprove" } (approval-required instances).
 * Approving also notifies the user by email and logs the moderation action.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action !== "approve" && body.action !== "unapprove") {
    return json({ error: "action must be 'approve' or 'unapprove'" }, 422);
  }
  const approved = body.action === "approve";

  await setActorApproval(env.DB, id, approved);

  let emailSent = false;
  if (approved && env.EMAIL && actor.email && actor.emailVerified) {
    try {
      await sendWelcomeEmail(env.EMAIL, {
        to: actor.email,
        from: env.FROM_EMAIL,
        username: actor.username,
        instanceTitle: env.INSTANCE_TITLE ?? "CF ActivityPub",
        instanceUrl: `https://${new URL(request.url).hostname}`,
      });
      emailSent = true;
    } catch (err) {
      console.error("[admin] approval email failed:", err);
    }
  }

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: id,
    action: approved ? "approved" : "unapproved",
    reason: approved ? "Registration approved by an administrator." : "Registration approval revoked.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain },
    emailSent,
    emailTo: actor.email,
    relatedId: null,
  });

  return json({ ok: true });
}

/**
 * DELETE /api/v1/admin/accounts/:id — permanently delete a local account from
 * the instance. Removes the actor row and every cascade-dependent row, plus
 * the sessions/activities/moderation entries that reference it without an FK.
 * This mirrors POST /api/v1/accounts/delete (self-delete) but for an admin.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  // Only local accounts have a private key to sign the federated Delete
  // tombstone. Remote actors are just cached copies — nothing to federate.
  if (actor.privateKeyPem) {
    // Federate a Delete(actor) tombstone before the actor row disappears so
    // remote servers can purge the profile and its posts (mirrors the
    // self-delete flow in POST /api/v1/accounts/delete).
    if (env.DELIVERY_QUEUE) {
      const deleteActivity = buildDelete(baseUrl, actor.id, actor.id, generateId());
      const followers = await env.DB
        .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
        .bind(actor.id)
        .all<{ actor_id: string }>();
      const fetchActor = async (followId: string): Promise<APActor | null> => {
        const cached = await getActorById(env.DB, followId);
        return cached as unknown as APActor | null;
      };
      const inboxes = await collectFollowerInboxes(followers.results.map((r) => r.actor_id), fetchActor);
      if (inboxes.length > 0) {
        await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(deleteActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
      }
    }
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
    action: "deleted",
    reason: "Account deleted by an administrator.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain },
    emailSent: false,
    emailTo: actor.email,
    relatedId: null,
  });

  return json({ ok: true });
}
