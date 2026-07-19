import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById } from "@/lib/db";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const target = await getActorById(env.DB, rawId);
  if (!target) return json({ error: "Not found" }, 404);
  await env.DB
    .prepare("DELETE FROM follows WHERE actor_id = ? AND target_id = ? AND state = 'accepted'")
    .bind(rawId, me.id)
    .run();
  return json({ id: rawId, following: false, showing_reblogs: false, notifying: false, followed_by: false, blocking: false, blocked_by: false, muting: false, muting_notifications: false, requested: false, domain_blocking: false, endorsed: false, note: "" });
}
