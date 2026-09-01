import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getPublicTimeline, getActorById, getAttachmentsByObjectIds, getPollsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds, getAllCustomEmojis, getReplyToAccountIdMap, getObjectQuotesCounts, getLastStatusAtMap } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { getQuotesByIds } from "@/lib/mastodon/quote";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import type { LocalActor } from "@/lib/types";
import { resolveLimits } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

/**
 * Minimal placeholder account for a remote status whose author could not be
 * resolved at render time. Keeps the federated timeline complete: a public
 * federated post is never dropped just because its origin server is unreachable.
 */
function placeholderActor(actorId: string): LocalActor {
  const hostname = new URL(actorId).hostname;
  const username = actorId.split("/").pop() ?? "unknown";
  return {
    id: actorId,
    username,
    domain: hostname,
    displayName: username,
    summary: null,
    avatarUrl: null,
    headerUrl: null,
    publicKeyPem: "",
    privateKeyPem: null,
    isLocal: false,
    isBot: false,
    manuallyApprovesFollowers: false,
    discoverable: false,
    followersCount: 0,
    followingCount: 0,
    statusesCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    email: null,
    passwordHash: null,
    emailVerified: false,
    autoDeleteAfter: null,
  };
}

// GET /api/v1/timelines/public
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const sinceIdRaw = searchParams.get("since_id") ?? undefined;
  const sinceId = sinceIdRaw ? decodeStatusId(sinceIdRaw, domain) : undefined;
  const local = searchParams.get("local") === "true";
  const remote = searchParams.get("remote") === "true";
  const onlyMedia = searchParams.get("only_media") === "true";
  const minIdRaw = searchParams.get("min_id") ?? undefined;
  const minId = minIdRaw ? decodeStatusId(minIdRaw, domain) : undefined;

  const authActor = await getAuthenticatedActor(request, env.DB);
  // The local timeline is restricted to authenticated users; the federated
  // timeline stays public.
  if (local && !authActor) return unauthorized();
  const objects = await getPublicTimeline(env.DB, limit, maxId, local, sinceId, remote, onlyMedia, minId, authActor?.id ?? undefined);

  const [attachmentMap, pollMap, likedIds, announcedIds, allEmojis, replyToMap, quotesCountMap, quotesById, filteredMap, lastStatusAtMap] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, objects.map((o) => o.id)),
    authActor ? getLikedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    authActor ? getAnnouncedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    getAllCustomEmojis(env.DB),
    getReplyToAccountIdMap(env.DB, objects),
    getObjectQuotesCounts(env.DB, objects.map((o) => o.id)),
    getQuotesByIds(env.DB, objects.map((o) => o.quoteId).filter(Boolean) as string[], domain),
    authActor ? getFilterResultsForStatuses(env.DB, authActor.id, objects) : Promise.resolve(new Map()),
    getLastStatusAtMap(env.DB, objects.map((o) => o.actorId)),
  ]);

  const statuses = await Promise.all(
    objects.map(async (obj) => {
  const authorExtras = await getStatusAuthorExtras(env.DB, objects.map((o) => o.actorId), domain);
      let author = await getActorById(env.DB, obj.actorId);
      // Attempt a live fetch if the actor is not cached yet (can happen for
      // statuses stored before actor caching was added).
      if (!author && obj.actorId.startsWith("https://")) {
        try {
          const { fetchRemoteObject } = await import("@/lib/activitypub/federation");
          const { upsertRemoteActor } = await import("@/lib/db");
          const fetched = await fetchRemoteObject(obj.actorId) as import("@/lib/types").APActor | null;
          if (fetched?.publicKey?.publicKeyPem) {
            await upsertRemoteActor(env.DB, fetched);
            author = await getActorById(env.DB, obj.actorId);
          }
        } catch { /* ignore */ }
      }
      // A stored public federated status must still appear even when its remote
      // author cannot be resolved right now (server unreachable, actor deleted).
      // Serialize it against a minimal placeholder account so the timeline is
      // complete rather than silently dropping the post.
      if (!author) author = placeholderActor(obj.actorId);
      const pollEntry = pollMap.get(obj.id);
      const poll = pollEntry ? serializePoll(pollEntry.poll, pollEntry.options, false, []) : null;
      return serializeStatus(obj, author, domain, {
        attachments: attachmentMap.get(obj.id) ?? [],
        poll,
        favourited: likedIds.has(obj.id),
        reblogged: announcedIds.has(obj.id),
        emojis: allEmojis,
        inReplyToAccountId: replyToMap.get(obj.id) ?? null,
        quote: obj.quoteId ? (quotesById.get(obj.quoteId) ?? null) : null,
        quotesCount: quotesCountMap.get(obj.id) ?? 0,
        filtered: filteredMap.get(obj.id) ?? [],
        authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null,
        authorSupportsCalls: authorExtras.get(obj.actorId)?.supportsCalls,
        authorMoved: authorExtras.get(obj.actorId)?.moved ?? null,
      });
    })
  );

  const result = statuses.filter(Boolean);

  const response = json(result);
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    response.headers.set("Link", buildPaginationLinks(request, oldest.id));
  }

  return response;
}