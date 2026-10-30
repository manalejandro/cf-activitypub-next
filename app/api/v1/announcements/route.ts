import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { toIsoOrNull, dbTimestamp } from "@/lib/dates";
import { resolveLimits } from "@/lib/constants";
import { getAuthenticatedActor } from "@/lib/auth";
import { getAdminRole } from "@/lib/admin-auth";
import { sanitizeFediverseHtml } from "@/lib/activitypub/sanitize";
import { linkifyHtmlText, localSummaryToPlain, processStatusContent } from "@/lib/activitypub/content";
import { resolveMentionLinks } from "@/lib/activitypub/mentions";
import { env } from "cloudflare:workers";

// Announcements are stored as the plain text an admin types in the composer.
// Convert it to the same linkified HTML used for statuses (URLs, @mentions,
// #hashtags, :emoji:) so the banner and /announcements render links instead of
// raw text. HTML pasted by the admin is sanitized first, mirroring remote
// content handling (serializers.renderRemoteContent).
async function renderAnnouncementContent(content: string, domain: string): Promise<string> {
  const raw = content ?? "";
  if (!raw) return "";
  const baseUrl = `https://${domain}`;
  // Only handles that resolve to a real account become links (`@algo` stays
  // plain text), same as statuses.
  const mentions = await resolveMentionLinks(env.DB, localSummaryToPlain(raw), baseUrl, env.KV);
  const isHtml = /<[a-z][\s>]/i.test(raw);
  if (isHtml) {
    const sanitized = sanitizeFediverseHtml(raw) ?? "";
    return linkifyHtmlText(sanitized, baseUrl, undefined, mentions);
  }
  return processStatusContent(localSummaryToPlain(raw), baseUrl, undefined, { mentions }).html;
}

// GET /api/v1/announcements — List announcements, with `read` status for the
// current actor (read = they have dismissed it).
export async function GET(request: NextRequest): Promise<Response> {
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

  const announcements = await Promise.all(
    rows.results.map(async (r) => ({
      id: r.id,
      content: await renderAnnouncementContent(r.content, domain),
      starts_at: toIsoOrNull(r.starts_at),
      ends_at: toIsoOrNull(r.ends_at),
      all_day: Boolean(r.all_day),
      published_at: toIsoOrNull(r.published_at) ?? new Date().toISOString(),
      updated_at: toIsoOrNull(r.updated_at) ?? new Date().toISOString(),
      read: Boolean(r.is_read),
    }))
  );

  return json(announcements);
}

// POST /api/v1/announcements — Create a new announcement (admin/moderator only).
export async function POST(request: NextRequest): Promise<Response> {
  const domain = new URL(request.url).hostname;

  // getAdminRole also accepts ADMIN_TOKEN operators (the old inline role
  // lookup silently rejected them).
  const role = await getAdminRole(request, env);
  if (role === null) return unauthorized();

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch { /* empty */ }

  const content = String(body.content ?? "").trim();
  if (!content) return json({ error: "content is required" }, 422);
  const maxAnnouncementChars = resolveLimits(env as unknown as Record<string, unknown>).maxAnnouncementChars;
  if (content.length > maxAnnouncementChars) return json({ error: `content is too long (max ${maxAnnouncementChars} chars)` }, 422);

  const id = crypto.randomUUID();
  // dbTimestamp, not string surgery (the column keeps datetime('now')'s
  // shape); the response normalizes to ISO like the GET does — the client
  // renders `new Date(published_at)` and the raw DB shape parses as local.
  const now = dbTimestamp();
  const nowIso = toIsoOrNull(now) ?? new Date().toISOString();

  await env.DB
    .prepare(
      `INSERT INTO announcements (id, content, starts_at, ends_at, all_day, published_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(id, content, null, null, now, now)
    .run();

  return json({
    id,
    content: await renderAnnouncementContent(content, domain),
    starts_at: null,
    ends_at: null,
    all_day: false,
    published_at: nowIso,
    updated_at: nowIso,
    read: false,
  });
}