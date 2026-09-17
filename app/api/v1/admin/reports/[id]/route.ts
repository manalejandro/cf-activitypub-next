import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getReportById, getActorById, getObjectById, getReportNotes } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { requireAdmin } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const report = await getReportById(env.DB, id);
  if (!report) return notFound();

  const [target, reporter] = await Promise.all([
    getActorById(env.DB, report.target_id),
    getActorById(env.DB, report.actor_id),
  ]);

  const statuses = await getReportStatuses(env.DB, report.status_ids, domain);

  const notes = (await getReportNotes(env.DB, id)).map((n) => ({
    id: n.id,
    content: n.content,
    created_at: n.created_at,
  }));

  return json({
    id: report.id,
    action_taken: report.action_taken,
    action_taken_at: null,
    category: report.category,
    comment: report.comment,
    forwarded: report.forwarded,
    created_at: report.created_at,
    status_ids: statuses.map((s) => s.id),
    statuses,
    rule_ids: report.rule_ids ? JSON.parse(report.rule_ids) : [],
    target_account: target ? serializeAccount(target, domain) : null,
    reporter_account: reporter ? serializeAccount(reporter, domain) : null,
    notes,
  });
}

async function getReportStatuses(db: D1Database, statusIdsRaw: string | null, domain: string): Promise<{ id: string; content: string; created_at: string | null; account: { id: string; username: string; acct: string; display_name: string; avatar: string } | null }[]> {
  if (!statusIdsRaw) return [];
  const statusIds = JSON.parse(statusIdsRaw) as string[];
  return (await Promise.all(
    statusIds.map(async (sid) => {
      const decoded = decodeStatusId(sid, domain);
      const obj = await getObjectById(db, decoded);
      if (!obj) return null;
      const author = await getActorById(db, obj.actorId);
      if (!author) return null;
      return {
        id: sid,
        content: obj.content ?? "",
        created_at: obj.published,
        account: serializeAccount(author, domain),
      };
    })
  )).filter((s): s is NonNullable<typeof s> => s !== null);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const report = await getReportById(env.DB, id);
  if (!report) return notFound();

  if (!report.action_taken) {
    return json({ error: "Report must be resolved before it can be deleted" }, 422);
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM report_notes WHERE report_id = ?").bind(id),
    env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id),
  ]);

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "report",
    targetId: id,
    action: "deleted",
    reason: "Report deleted by an administrator.",
    confidence: null,
    model: "admin",
    details: { target_id: report.target_id },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ id, deleted: true });
}
