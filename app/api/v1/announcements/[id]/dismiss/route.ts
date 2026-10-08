import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { env } from "cloudflare:workers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const announcement = await env.DB
    .prepare("SELECT id FROM announcements WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!announcement) return notFound();
  await env.DB
    .prepare("DELETE FROM announcement_reactions WHERE announcement_id = ? AND actor_id = ?")
    .bind(id, me.id)
    .run();
  await env.DB
    .prepare("INSERT INTO announcement_reactions (id, announcement_id, actor_id, name) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), id, me.id, "dismiss")
    .run();
  return json({});
}
