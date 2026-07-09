import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getActorFields } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  await env.DB.prepare("UPDATE actors SET avatar_url = NULL, updated_at = datetime('now') WHERE id = ?").bind(actor.id).run();

  const updated = await getActorById(env.DB, actor.id);
  const fields = await getActorFields(env.DB, actor.id);
  return json(serializeAccount(updated!, domain, { isCurrentUser: true, fields }));
}