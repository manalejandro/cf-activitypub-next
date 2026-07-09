import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getReportById, getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const { id } = await params;
  const report = await getReportById(env.DB, id);
  if (!report) return notFound();

  await env.DB.prepare("UPDATE reports SET action_taken = 1 WHERE id = ?").bind(id).run();

  const updated = await getReportById(env.DB, id);
  const target = await getActorById(env.DB, updated!.target_id);

  return json({
    id: updated!.id,
    action_taken: true,
    action_taken_at: new Date().toISOString(),
    category: updated!.category,
    comment: updated!.comment,
    forwarded: updated!.forwarded,
    created_at: updated!.created_at,
    status_ids: updated!.status_ids ? JSON.parse(updated!.status_ids) : [],
    rule_ids: updated!.rule_ids ? JSON.parse(updated!.rule_ids) : [],
    target_account: target ? serializeAccount(target, "") : null,
  });
}
