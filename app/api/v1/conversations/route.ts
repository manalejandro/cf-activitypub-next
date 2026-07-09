import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getConversations } from "@/lib/db";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "20"), 40);

  const conversations = await getConversations(env.DB, actor.id, limit);

  const { getObjectById, getActorById } = await import("@/lib/db");
  const { serializeStatus, serializeAccount } = await import("@/lib/mastodon/serializers");

  const result = await Promise.all(
    conversations.map(async (c) => {
      let lastStatus = null;
      let accounts: unknown[] = [];

      if (c.last_status_id) {
        const obj = await getObjectById(env.DB, c.last_status_id);
        if (obj) {
          const author = await getActorById(env.DB, obj.actorId);
          if (author) {
            lastStatus = serializeStatus(obj, author, domain);
            // For direct messages, the other participant is the author
            if (obj.visibility === "direct") {
              accounts = [serializeAccount(author, domain)];
            }
          }
        }
      }

      return {
        id: c.id,
        unread: c.unread,
        accounts,
        last_status: lastStatus,
      };
    })
  );

  return json(result);
}
