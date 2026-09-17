import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { accountActionGuard } from "@/lib/admin/account-guards";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  const denied = await accountActionGuard(request, env, actor, { removesAccess: false });
  if (denied) return denied;

  await env.DB
    .prepare("UPDATE actors SET suspended = 0, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "account",
    targetId: id,
    action: "unsuspended",
    reason: "Account suspension lifted by an administrator.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ id, suspended: false });
}
