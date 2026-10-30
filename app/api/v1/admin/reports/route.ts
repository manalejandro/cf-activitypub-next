import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import { getActorsByIds, getObjectsByIds, getAttachmentsByObjectIds, getAllCustomEmojis, getReportNotes } from "@/lib/db";
import { renderEmojiInHtml } from "@/lib/emoji";
import { sanitizeFediverseHtml } from "@/lib/activitypub/sanitize";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import type { LocalObject, LocalActor, LocalAttachment, LocalCustomEmoji } from "@/lib/types";
import { env } from "cloudflare:workers";
import { toIsoOrNull } from "@/lib/dates";

interface ReportRow {
  id: string;
  actor_id: string;
  target_id: string;
  status_ids: string | null;
  comment: string;
  category: string;
  rule_ids: string | null;
  forwarded: number;
  action_taken: number;
  created_at: string;
}

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
      .all<ReportRow>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>(),
  ]);
  const reports = rows.results;

  // Batch every lookup (AGENTS: a page must never make a round trip per row).
  // The emoji catalogue used to be read once PER REPORT (a full-table scan
  // each), and the target/reporter actors plus every reported status's object,
  // author and attachments were fetched per row too. Resolve them all in a few
  // queries for the whole page instead.
  const emojis = await getAllCustomEmojis(env.DB);

  const sidsByReport = new Map<string, string[]>();
  const decodedByReport = new Map<string, string[]>();
  const allObjectIds: string[] = [];
  for (const r of reports) {
    const sids = parseStatusIds(r.status_ids);
    const decoded = sids.map((sid) => decodeStatusId(sid, domain));
    sidsByReport.set(r.id, sids);
    decodedByReport.set(r.id, decoded);
    allObjectIds.push(...decoded);
  }
  const objectMap = await getObjectsByIds(env.DB, allObjectIds);

  const actorIds = new Set<string>();
  for (const r of reports) {
    actorIds.add(r.target_id);
    actorIds.add(r.actor_id);
  }
  for (const o of objectMap.values()) actorIds.add(o.actorId);
  const actorsMap = await getActorsByIds(env.DB, [...actorIds]);

  const attachmentsMap = await getAttachmentsByObjectIds(env.DB, [...objectMap.keys()]);

  const result = await Promise.all(
    reports.map(async (r) => {
      const statuses = buildReportStatuses(
        sidsByReport.get(r.id) ?? [],
        decodedByReport.get(r.id) ?? [],
        objectMap,
        actorsMap,
        attachmentsMap,
        emojis,
        domain
      );
      const notes = (await getReportNotes(env.DB, r.id)).map((n) => ({
        id: n.id,
        content: n.content,
        // Admin::Report is a Mastodon-shaped API: created_at must be ISO, and
        // the columns keep datetime('now')'s shape (external admin tools parse
        // it as local time otherwise).
        created_at: toIsoOrNull(n.created_at) ?? n.created_at,
      }));
      const target = actorsMap.get(r.target_id) ?? null;
      const reporter = actorsMap.get(r.actor_id) ?? null;
      return {
        id: r.id,
        action_taken: Boolean(r.action_taken),
        action_taken_at: null,
        category: r.category,
        comment: r.comment,
        forwarded: Boolean(r.forwarded),
        created_at: toIsoOrNull(r.created_at) ?? r.created_at,
        status_ids: statuses.map((s) => s.id),
        statuses,
        rule_ids: r.rule_ids ? JSON.parse(r.rule_ids) : [],
        target_account: target ? serializeAccount(target, domain, { emojis }) : null,
        reporter_account: reporter ? serializeAccount(reporter, domain, { emojis }) : null,
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

function parseStatusIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * The evidence a report carries, built from the page's pre-fetched maps (no per
 * status round trip). A suspended account's posts are nulled by moderation
 * ("stop spreading"), so the text is recovered from the stored AP document — the
 * admin judging the report must see what was reported — and the attachments are
 * included (an image is often the whole report). Statuses that no longer exist
 * are kept as placeholders instead of silently disappearing.
 */
function buildReportStatuses(
  sids: string[],
  decodedIds: string[],
  objectMap: Map<string, LocalObject>,
  actorsMap: Map<string, LocalActor>,
  attachmentsMap: Map<string, LocalAttachment[]>,
  emojis: LocalCustomEmoji[],
  domain: string
): ReportStatus[] {
  return sids.map((sid, i): ReportStatus => {
    const obj = objectMap.get(decodedIds[i]) ?? null;
    const author = obj ? actorsMap.get(obj.actorId) ?? null : null;
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

    const attachments = attachmentsMap.get(obj.id) ?? [];
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
  });
}
