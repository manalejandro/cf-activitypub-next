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

  // Remote accounts require an authenticated session: refresh from source for
  // up-to-date counts, then verify/ sync as below. Anonymous visitors only get
  // local accounts (public profiles).
  // Remote actor IRIs require a session; a bare local IRI does not (local
  // profiles are public — the anonymous client just addressed the account by
  // its serialized `id` instead of `acct`).
  if (rawId.startsWith("https://") && !rawId.startsWith(`https://${domain}/`)) {
    if (!me) return unauthorized();
    const refreshed = await fetchAndCacheRemoteActor(env.DB, rawId, env.KV);
    if (refreshed) {
      actor = await getActorById(env.DB, refreshed.id) ?? actor;
      if (refreshed.domain !== domain) {
        supportsCalls = await getDomainCallsSupport(env.DB, refreshed.domain);
      }
    }
  }

  if (!actor) {
    // Explain why an on-demand remote resolution failed: an instance that
    // rejects our deliveries (403) is blocking us.
    try {
      const target = rawId.startsWith("http") ? new URL(rawId) : null;
      if (target && target.hostname !== domain) {
        const rej = await env.DB
          .prepare(
            `SELECT status FROM delivery_rejections
             WHERE domain = ? AND status IN (0, 403)
               AND (last_ok_at IS NULL OR last_at > last_ok_at)`
          )
          .bind(target.hostname)
          .first<{ status: number }>();
        if (rej?.status === 403) {
          return json({ error: "This account's server is blocking you", error_code: "remote_blocked" }, 403);
        }
        if (rej?.status === 0) {
          return json({ error: "This account's server is unreachable", error_code: "remote_unreachable" }, 502);
        }
      }
    } catch { /* fall through to 404 */ }
    return notFound("Account not found");
  }
  if (!actor.isLocal && !me) return unauthorized();

  // These do outbound requests (verification, FEP-7aa9 collection sync).
  if (!actor.isLocal) {
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
