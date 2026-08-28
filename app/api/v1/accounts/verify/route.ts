import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorFields, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { verifyAccountFields } from "@/lib/activitypub/verification";

// POST /api/v1/accounts/verify — re-run the rel="me" verification for the
// current user's profile fields and return the updated account so the badge
// reflects the fresh result.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  await verifyAccountFields(env.DB, actor.id, domain);

  const fields = await getActorFields(env.DB, actor.id);
  return json(
    serializeAccount(actor, domain, {
      isCurrentUser: true,
      fields,
      emojis: await getAllCustomEmojis(env.DB),
    })
  );
}