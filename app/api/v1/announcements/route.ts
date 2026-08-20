import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { sanitizeFediverseHtml } from "@/lib/activitypub/sanitize";
import { linkifyHtmlText, localSummaryToPlain, processStatusContent } from "@/lib/activitypub/content";

// Announcements are stored as the plain text an admin types in the composer.
// Convert it to the same linkified HTML used for statuses (URLs, @mentions,
// #hashtags, :emoji:) so the banner and /announcements render links instead of
// raw text. HTML pasted by the admin is sanitized first, mirroring remote
// content handling (serializers.renderRemoteContent).
function renderAnnouncementContent(content: string, domain: string): string {
  const raw = content ?? "";
  if (!raw) return "";
  const baseUrl = `https://${domain}`;
  const isHtml = /<[a-z][\s>]/i.test(raw);
  if (isHtml) {
    const sanitized = sanitizeFediverseHtml(raw) ?? "";
    return linkifyHtmlText(sanitized, baseUrl);
  }
  return processStatusContent(localSummaryToPlain(raw), baseUrl).html;
}

// GET /api/v1/announcements — List announcements, with `read` status for the
// current actor (read = they have dismissed it).
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const rows = await env.DB.prepare(
    `SELECT a.id, a.content, a.starts_at, a.ends_at, a.all_day, a.published_at, a.updated_at,
            EXISTS(SELECT 1 FROM announcement_reactions r
                   WHERE r.announcement_id = a.id AND r.actor_id = ? AND r.name = 'dismiss') AS is_read
     FROM announcements a
     ORDER BY a.published_at DESC`
  ).bind(actor.id).all<{
    id: string;
    content: string;
    starts_at: string | null;
    ends_at: string | null;
    all_day: number;
    published_at: string;
    updated_at: string;
    is_read: number;
  }>();

  return json(rows.results.map((r) => ({
    id: r.id,
    content: renderAnnouncementContent(r.content, domain),
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    all_day: Boolean(r.all_day),
    published_at: r.published_at,
    updated_at: r.updated_at,
    read: Boolean(r.is_read),
  })));
}

// POST /api/v1/announcements — Create a new announcement (admin/moderator only).
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const roleRow = await env.DB
    .prepare("SELECT role FROM actors WHERE id = ?")
    .bind(actor.id)
    .first<{ role: string }>();
  const role = roleRow?.role ?? "user";
  if (role !== "admin" && role !== "moderator") {
    return json({ error: "Only admins can create announcements" }, 403);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch { /* empty */ }

  const content = String(body.content ?? "").trim();
  if (!content) return json({ error: "content is required" }, 422);
  if (content.length > 10000) return json({ error: "content is too long (max 10000 chars)" }, 422);

  const id = crypto.randomUUID();
  const now = new Date().toISOString().replace("T", " ").replace("Z", "").slice(0, 19);

  await env.DB
    .prepare(
      `INSERT INTO announcements (id, content, starts_at, ends_at, all_day, published_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(id, content, null, null, now, now)
    .run();

  return json({
    id,
    content: renderAnnouncementContent(content, domain),
    starts_at: null,
    ends_at: null,
    all_day: false,
    published_at: now,
    updated_at: now,
    read: false,
  });
}