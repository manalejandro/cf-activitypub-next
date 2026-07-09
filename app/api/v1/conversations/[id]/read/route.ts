import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getConversationById, markConversationRead, getObjectById, getActorById } from "@/lib/db";
import { serializeStatus, serializeAccount } from "@/lib/mastodon/serializers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const conv = await getConversationById(env.DB, id);
  if (!conv) return notFound();
  if (conv.actor_id !== actor.id) return notFound();

  await markConversationRead(env.DB, id);

  let lastStatus = null;
  let accounts: unknown[] = [];

  if (conv.last_status_id) {
    const obj = await getObjectById(env.DB, conv.last_status_id);
    if (obj) {
      const author = await getActorById(env.DB, obj.actorId);
      if (author) {
        lastStatus = serializeStatus(obj, author, domain);
        if (obj.visibility === "direct") {
          accounts = [serializeAccount(author, domain)];
        }
      }
    }
  }

  return json({
    id: conv.id,
    unread: false,
    accounts,
    last_status: lastStatus,
  });
}
