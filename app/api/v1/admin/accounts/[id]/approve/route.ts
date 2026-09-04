import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { requireAdmin } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { sendWelcomeEmail } from "@/lib/email";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  // Approval-required registrations pend with approved=0; approving marks the
  // account active. email_verified=1 keeps the legacy "approve" behaviour for
  // accounts that never clicked their verification link.
  await env.DB
    .prepare("UPDATE actors SET approved = 1, email_verified = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();

  let emailSent = false;
  if (env.EMAIL && actor.email) {
    try {
      await sendWelcomeEmail(env.EMAIL, {
        to: actor.email,
        from: env.FROM_EMAIL,
        username: actor.username,
        instanceTitle: env.INSTANCE_TITLE ?? "CF ActivityPub",
        instanceUrl: `https://${domain}`,
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
    action: "approved",
    reason: "Registration approved by an administrator.",
    confidence: null,
    model: "admin",
    details: { username: actor.username, domain: actor.domain },
    emailSent,
    emailTo: actor.email,
    relatedId: null,
  });

  const updated = await getActorById(env.DB, id);
  return json({
    id: updated!.id,
    account: serializeAccount(updated!, domain),
  });
}