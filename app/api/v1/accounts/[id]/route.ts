import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getActorFields, getDomainCallsSupport, getLastStatusAt, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { maybeVerifyRemoteAccount } from "@/lib/activitypub/verification";
import { getAuthenticatedActor } from "@/lib/auth";

// GET /api/v1/accounts/:id
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const rawId = decodeURIComponent(id);
  let supportsCalls: boolean | undefined;

  const me = await getAuthenticatedActor(request, env.DB);

  let actor = await getActorById(env.DB, rawId);

  // For remote actors: always re-fetch from source to get up-to-date counts.
  // For actors not yet in DB: fetch and cache first.
  // Resolution is authenticated-only: an anonymous visitor must not be able to
  // make the instance fetch (or serve) remote accounts.
  if (rawId.startsWith("https://")) {
    if (!me) return unauthorized();
    const refreshed = await fetchAndCacheRemoteActor(env.DB, rawId, env.KV);
    if (refreshed) {
      actor = await getActorById(env.DB, refreshed.id) ?? actor;
      if (refreshed.domain !== domain) {
        supportsCalls = await getDomainCallsSupport(env.DB, refreshed.domain);
      }
    }
  }

  if (!actor) return notFound("Account not found");
  if (!actor.isLocal && !me) return unauthorized();

  // Remote accounts are verified on demand (cached in KV) so the badge shows
  // without depending on the cron.
  if (!actor.isLocal) {
    await maybeVerifyRemoteAccount(env.DB, env.KV, actor.id, domain);
  }

  const fields = await getActorFields(env.DB, actor.id);
  const lastStatusAt = await getLastStatusAt(env.DB, actor.id);

  // Populate `moved` (the account this one migrated to) when set.
  let movedAccount: ReturnType<typeof serializeAccount> | null = null;
  if (actor.movedTo) {
    const moved = await getActorById(env.DB, actor.movedTo);
    if (moved) {
      const movedFields = await getActorFields(env.DB, moved.id);
      movedAccount = serializeAccount(moved, domain, { fields: movedFields });
    }
  }

  return json(serializeAccount(actor, domain, { fields, supportsCalls, lastStatusAt, moved: movedAccount, emojis: await getAllCustomEmojis(env.DB) }));
}
