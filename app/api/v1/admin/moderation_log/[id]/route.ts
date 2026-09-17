import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getAdminRole } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

/**
 * DELETE /api/v1/admin/moderation_log/:id — remove a single moderation_log row.
 * Full-admin only: a moderator erasing their own audit entries would defeat the
 * audit trail (the bulk wipe has always required a full admin).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }

  const { id } = await params;
  const res = await env.DB.prepare("DELETE FROM moderation_log WHERE id = ?").bind(id).run();
  if (res.meta.changes === 0) return notFound();

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "instance",
    targetId: id,
    action: "log_deleted",
    reason: "Audit-log entry removed by an administrator.",
    confidence: null,
    model: "admin",
    details: {},
    emailSent: false,
    emailTo: null,
    relatedId: id,
  });

  return json({ ok: true });
}
