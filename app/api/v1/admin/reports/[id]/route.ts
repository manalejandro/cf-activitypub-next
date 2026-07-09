import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getReportById, getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const { id } = await params;
  const report = await getReportById(env.DB, id);
  if (!report) return notFound();

  const target = await getActorById(env.DB, report.target_id);

  return json({
    id: report.id,
    action_taken: report.action_taken,
    action_taken_at: null,
    category: report.category,
    comment: report.comment,
    forwarded: report.forwarded,
    created_at: report.created_at,
    status_ids: report.status_ids ? JSON.parse(report.status_ids) : [],
    rule_ids: report.rule_ids ? JSON.parse(report.rule_ids) : [],
    target_account: target ? serializeAccount(target, "") : null,
  });
}
