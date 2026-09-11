import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, getActorFields, getDomainCallsSupport, getLastStatusAt, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { syncRemoteCollections } from "@/lib/activitypub/collections";
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

  // For remote actors: authenticated requests refresh from source to get
  // up-to-date counts; anonymous visitors may only read the cached copy (never
  // trigger an outbound resolution/fetch).
  if (rawId.startsWith("https://")) {
    if (me) {
      const refreshed = await fetchAndCacheRemoteActor(env.DB, rawId, env.KV);
      if (refreshed) {
        actor = await getActorById(env.DB, refreshed.id) ?? actor;
        if (refreshed.domain !== domain) {
          supportsCalls = await getDomainCallsSupport(env.DB, refreshed.domain);
        }
      }
    } else if (!actor) {
      return unauthorized();
    }
  }

  if (!actor) return notFound("Account not found");

  // These do outbound requests (verification, FEP-7aa9 collection sync), so
  // they only run for authenticated visitors.
  if (!actor.isLocal && me) {
    await syncRemoteCollections(env.DB, env.KV, actor.id).catch(() => {});
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
