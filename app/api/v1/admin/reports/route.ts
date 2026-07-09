import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const rows = await env.DB
    .prepare("SELECT id, actor_id, target_id, status_ids, comment, category, rule_ids, forwarded, action_taken, created_at FROM reports ORDER BY created_at DESC LIMIT 40")
    .all<{ id: string; actor_id: string; target_id: string; status_ids: string | null; comment: string; category: string; rule_ids: string | null; forwarded: number; action_taken: number; created_at: string }>();

  const { getActorById } = await import("@/lib/db");
  const { serializeAccount } = await import("@/lib/mastodon/serializers");

  const result = await Promise.all(
    rows.results.map(async (r) => {
      const target = await getActorById(env.DB, r.target_id);
      return {
        id: r.id,
        action_taken: Boolean(r.action_taken),
        action_taken_at: null,
        category: r.category,
        comment: r.comment,
        forwarded: Boolean(r.forwarded),
        created_at: r.created_at,
        status_ids: r.status_ids ? JSON.parse(r.status_ids) : [],
        rule_ids: r.rule_ids ? JSON.parse(r.rule_ids) : [],
        target_account: target ? serializeAccount(target, "") : null,
      };
    })
  );

  return json(result);
}
