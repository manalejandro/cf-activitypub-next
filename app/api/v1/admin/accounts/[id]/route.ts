import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorById, setActorApproval } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { getAdminRole, requireAdmin } from "@/lib/admin-auth";
import { accountActionGuard } from "@/lib/admin/account-guards";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { deleteLocalAccount } from "@/lib/account-deletion";
import { notifyAccountOwner } from "@/lib/moderation/actions";
import { sendWelcomeEmail } from "@/lib/email";
import { env } from "cloudflare:workers";
import { toIsoOrNull } from "@/lib/dates";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
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
    created_at: toIsoOrNull(actor.createdAt) ?? actor.createdAt,
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

  // Unapproving removes the account's access (getAuthenticatedActor rejects
  // pending accounts): never the reserved actor, yourself or the last admin.
  if (!approved) {
    const denied = await accountActionGuard(request, env, actor, { removesAccess: true });
    if (denied) return denied;
  }

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
 * DELETE /api/v1/admin/accounts/:id — permanently delete an account from the
 * instance. Removes the actor row and every cascade-dependent row, plus the
 * sessions/activities/moderation entries that reference it without an FK (the
 * owner's own `POST /api/v1/accounts/delete` shares the work).
 *
 * **Full administrators only**: a moderator can suspend, silence, approve or
 * reject an account, but deleting one is irreversible (posts, followers and
 * uploads go with it), so it is reserved to administrators. This mirrors how
 * instance mutations, role changes and audit wipes are guarded.
 * `accountActionGuard` still blocks self-actions, the reserved instance actor,
 * administrator targets and removing the last administrator's access.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return role
      ? json({ error: "Administrator role required", error_code: "admin_account_delete_admin_only" }, 403)
      : json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();
  const denied = await accountActionGuard(request, env, actor, { removesAccess: true });
  if (denied) return denied;

  // Tell the owner before the actor row disappears (local accounts with an
  // email on file only — remote cached actors have nothing to notify).
  const emailSent = await notifyAccountOwner(env, actor, "removed", "Su cuenta ha sido eliminada por la administración.");

  if (actor.isLocal) {
    // Same deletion as the owner's self-delete: federated Delete{Actor} to the
    // accepted followers, uploads removed from R2, actor row and cascades gone.
    await deleteLocalAccount(env, actor, {
      reason: "Account deleted by an administrator.",
      source: "user",
      emailSent,
    });
    return json({ ok: true });
  }

  // Remote cached actor: nothing to federate, just drop the cached copy.
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
    emailSent,
    emailTo: actor.email,
    relatedId: null,
  });

  return json({ ok: true });
}
