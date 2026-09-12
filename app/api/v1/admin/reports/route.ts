import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import { getActorById, getObjectById, getReportNotes } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(parseInt(params.get("limit") ?? "40", 10), 1), 100);
  const offset = Math.max(parseInt(params.get("offset") ?? "0", 10), 0);
  const [rows, totalRow] = await Promise.all([
    env.DB
      .prepare("SELECT id, actor_id, target_id, status_ids, comment, category, rule_ids, forwarded, action_taken, created_at FROM reports ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .bind(limit, offset)
      .all<{ id: string; actor_id: string; target_id: string; status_ids: string | null; comment: string; category: string; rule_ids: string | null; forwarded: number; action_taken: number; created_at: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>(),
  ]);

  const result = await Promise.all(
    rows.results.map(async (r) => {
      const [target, reporter] = await Promise.all([
        getActorById(env.DB, r.target_id),
        getActorById(env.DB, r.actor_id),
      ]);
      const statuses = await getReportStatuses(env.DB, r.status_ids, domain);
      const notes = (await getReportNotes(env.DB, r.id)).map((n) => ({
        id: n.id,
        content: n.content,
        created_at: n.created_at,
      }));
      return {
        id: r.id,
        action_taken: Boolean(r.action_taken),
        action_taken_at: null,
        category: r.category,
        comment: r.comment,
        forwarded: Boolean(r.forwarded),
        created_at: r.created_at,
        status_ids: statuses.map((s) => s.id),
        statuses,
        rule_ids: r.rule_ids ? JSON.parse(r.rule_ids) : [],
        target_account: target ? serializeAccount(target, domain) : null,
        reporter_account: reporter ? serializeAccount(reporter, domain) : null,
        notes,
      };
    })
  );

  return json({ reports: result, total: Number(totalRow?.n ?? 0) });
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
