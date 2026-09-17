import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { getAdminRole } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

/**
 * POST /api/v1/admin/accounts/:id/promote — raise an account one step:
 * user → moderator → admin. An existing admin is left untouched (this used to
 * downgrade admins to moderators, which is how the operator account ended up
 * without admin rights while only the Guardian bot kept them).
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
  // The instance/guardian actor is reserved: its role must never change.
  if (actor.reserved) {
    return json({ error: "Cannot change the instance actor's role" }, 422);
  }

  const current = actor.role ?? "user";
  if (current === "admin") {
    return json({ id, role: "admin", changed: false });
  }
  const target = current === "moderator" ? "admin" : "moderator";

  try {
    await env.DB.prepare("UPDATE actors SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(target, id).run();
  } catch {
    return json({ error: "Missing role column — run migration: npx wrangler d1 execute cf-ap --remote --file=lib/db/migrations/007-admin-columns.sql" }, 500);
  }

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: id,
    action: "promoted",
    reason: `Role changed from ${current} to ${target} by an administrator.`,
    confidence: null,
    model: "admin",
    details: { from: current, to: target },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ id, role: target, changed: true });
}
