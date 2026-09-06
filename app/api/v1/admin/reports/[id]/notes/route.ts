import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, badRequest } from "@/lib/cf";
import { getReportById, createReportNote, getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { requireAdmin } from "@/lib/admin-auth";
import { getAuthenticatedActor } from "@/lib/auth";
import { generateId } from "@/lib/activitypub/utils";
import { MAX_REPORT_NOTE_CHARS } from "@/lib/constants";

// POST /api/v1/admin/reports/:id/notes — add an internal moderation note to a
// report ticket. Mirrors Mastodon's report_notes (internal only, not federated).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const report = await getReportById(env.DB, id);
  if (!report) return notFound();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return json({ error: "Unauthorized" }, 401);

  const body = await request.json() as { content?: string };
  const content = (body.content ?? "").trim();
  if (!content) return badRequest("content is required");

  const noteId = generateId();
  await createReportNote(env.DB, noteId, id, actor.id, content.slice(0, MAX_REPORT_NOTE_CHARS));

  const author = await getActorById(env.DB, actor.id);

  return json({
    id: noteId,
    report_id: id,
    content,
    created_at: new Date().toISOString(),
    account: author ? serializeAccount(author, domain) : null,
  });
}