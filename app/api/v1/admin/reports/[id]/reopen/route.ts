import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getReportById } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const report = await getReportById(env.DB, id);
  if (!report) return notFound();

  await env.DB.prepare("UPDATE reports SET action_taken = 0 WHERE id = ?").bind(id).run();

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "report",
    targetId: id,
    action: "reopened",
    reason: "Report reopened by an administrator.",
    confidence: null,
    model: "admin",
    details: { target_id: report.target_id },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ id, action_taken: false, reopened: true });
}