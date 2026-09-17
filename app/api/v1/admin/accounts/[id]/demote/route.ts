import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { countUsableAdmins, getActorById } from "@/lib/db";
import { getAdminRole } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

/**
 * POST /api/v1/admin/accounts/:id/demote — lower an account one step:
 * admin → moderator → user. The last full administrator can never be demoted
 * (the instance would be left without anyone who can manage roles).
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
  if (actor.reserved) {
    return json({ error: "Cannot change the instance actor's role" }, 422);
  }

  const current = actor.role ?? "user";
  if (current !== "moderator" && current !== "admin") {
    return json({ error: "Account is not a moderator or administrator" }, 422);
  }
  if (current === "admin" && (await countUsableAdmins(env.DB, id)) === 0) {
    return json({ error: "Cannot demote the last administrator" }, 422);
  }
  const target = current === "admin" ? "moderator" : "user";

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
    action: "demoted",
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
