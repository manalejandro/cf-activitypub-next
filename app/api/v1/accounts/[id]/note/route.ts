import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById } from "@/lib/db";
import { buildRelationship } from "@/lib/mastodon/relationships";
import { env } from "cloudflare:workers";

// Mastodon's AccountNote limit (AccountNote::MAX_COMMENT_LENGTH).
const MAX_NOTE_CHARS = 2000;

// POST /api/v1/accounts/:id/note — the private note one account keeps about
// another. Returns the **Relationship** (Mastodon parity): the client needs the
// stored `note` back to show what it just saved.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const target = await getActorById(env.DB, rawId);
  if (!target) return notFound();
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "Invalid request" }, 400);
  }
  const body = (await request.json().catch(() => ({}))) as { comment?: string };
  if (typeof body.comment === "string") {
    // An empty comment clears the note (the row stays, like Mastodon's upsert).
    const comment = body.comment.slice(0, MAX_NOTE_CHARS);
    await env.DB
      .prepare(
        `INSERT INTO account_notes (id, actor_id, target_id, comment, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(actor_id, target_id) DO UPDATE SET comment = excluded.comment, updated_at = excluded.updated_at`
      )
      .bind(crypto.randomUUID(), me.id, rawId, comment)
      .run();
  }
  return json(await buildRelationship(env.DB, me.id, rawId));
}
