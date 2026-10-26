import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import { getActorById, getAttachmentsByObjectId, getAllCustomEmojis, getObjectById, getReportNotes } from "@/lib/db";
import { renderEmojiInHtml } from "@/lib/emoji";
import { sanitizeFediverseHtml } from "@/lib/activitypub/sanitize";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { env } from "cloudflare:workers";

export async function GET(request: NextRequest): Promise<Response> {
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

interface ReportStatus {
  id: string;
  content: string;
  created_at: string | null;
  account: { id: string; username: string; acct: string; display_name: string; avatar: string } | null;
  media: { url: string; type: string; description: string | null }[];
  /** The stored post is gone (deleted by moderation or on its origin). */
  unavailable?: boolean;
}

/**
 * The evidence a report carries. A suspended account's posts are nulled by
 * moderation ("stop spreading"), so the text is recovered from the stored AP
 * document — the admin judging the report must see what was reported — and the
 * attachments are included (an image is often the whole report). Statuses that
 * no longer exist are kept as placeholders instead of silently disappearing.
 */
async function getReportStatuses(db: D1Database, statusIdsRaw: string | null, domain: string): Promise<ReportStatus[]> {
  if (!statusIdsRaw) return [];
  let statusIds: string[] = [];
  try {
    statusIds = JSON.parse(statusIdsRaw) as string[];
  } catch {
    return [];
  }
  const emojis = await getAllCustomEmojis(db);

  return Promise.all(
    statusIds.map(async (sid): Promise<ReportStatus> => {
      const decoded = decodeStatusId(sid, domain);
      const obj = await getObjectById(db, decoded);
      const author = obj ? await getActorById(db, obj.actorId) : null;
      if (!obj || !author) {
        return { id: sid, content: "", created_at: null, account: null, media: [], unavailable: true };
      }

      let content = obj.content ?? "";
      if (!content) {
        try {
          const raw = JSON.parse(obj.raw) as { content?: string; tag?: { type?: string; icon?: { url?: string }; name?: string }[] };
          // The stored AP document is raw remote HTML: sanitize it here rather
          // than relying on the single client-side parser (defence in depth
          // against a deliberately hostile reported status).
          if (typeof raw.content === "string") content = sanitizeFediverseHtml(raw.content) ?? "";
          const rawEmojis = (raw.tag ?? [])
            .filter((t) => t.type === "Emoji" && typeof t.name === "string" && t.icon?.url)
            .map((t) => ({
              shortcode: String(t.name).replace(/^:/, "").replace(/:$/, ""),
              url: t.icon!.url!,
              static_url: t.icon!.url!,
            }));
          if (rawEmojis.length > 0) content = renderEmojiInHtml(content, rawEmojis);
        } catch { /* malformed raw: keep whatever was stored */ }
      }

      const attachments = await getAttachmentsByObjectId(db, obj.id);
      return {
        id: sid,
        content,
        created_at: obj.published,
        account: serializeAccount(author, domain, { emojis }),
        media: attachments.map((a) => ({
          url: a.url,
          type: a.type,
          description: a.description ?? null,
        })),
      };
    })
  );
}
