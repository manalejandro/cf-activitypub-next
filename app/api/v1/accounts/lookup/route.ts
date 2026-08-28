import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorByUsername, getActorFields, getLastStatusAt, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { maybeVerifyRemoteAccount } from "@/lib/activitypub/verification";

// GET /api/v1/accounts/lookup?acct=username[@domain]
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const acct = request.nextUrl.searchParams.get("acct");

  if (!acct) return json({ error: "acct parameter required" }, 422);

  // Parse acct: "username" or "username@domain"
  const [username, actorDomain] = acct.includes("@")
    ? acct.split("@", 2)
    : [acct, domain];

  const actor = await getActorByUsername(env.DB, username, actorDomain ?? domain);
  if (!actor) return notFound("Account not found");

  // Remote accounts are verified on demand (cached in KV) so the badge shows
  // without depending on the cron.
  if (!actor.isLocal) {
    await maybeVerifyRemoteAccount(env.DB, env.KV, actor.id, domain);
  }

  const fields = await getActorFields(env.DB, actor.id);
  const lastStatusAt = await getLastStatusAt(env.DB, actor.id);
  const emojis = await getAllCustomEmojis(env.DB);
  return json(serializeAccount(actor, domain, { fields, lastStatusAt, emojis }));
}
