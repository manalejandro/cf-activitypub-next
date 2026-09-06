import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorFields, getAllCustomEmojis, getActorPreference } from "@/lib/db";
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
  const postingLanguage = (await getActorPreference(env.DB, actor.id, "posting:default:language")) ?? "en";
  const postingVisibility = (await getActorPreference(env.DB, actor.id, "posting:default:visibility")) ?? "public";
  const postingSensitive = (await getActorPreference(env.DB, actor.id, "posting:default:sensitive")) === "true";
  const followRequestsRow = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM follows WHERE target_id = ? AND state = 'pending'")
    .bind(actor.id)
    .first<{ c: number }>();
  const followRequestsCount = Number(followRequestsRow?.c ?? 0);
  return json(
    serializeAccount(actor, domain, {
      isCurrentUser: true,
      fields,
      emojis: await getAllCustomEmojis(env.DB),
      language: postingLanguage,
      privacy: postingVisibility,
      sensitive: postingSensitive,
      followRequestsCount,
    })
  );
}