import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getHomeTimeline, getActorById, getAttachmentsByObjectIds, getPollsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds, getAllCustomEmojis, getReplyToAccountIdMap, getObjectQuotesCounts } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { getQuotesByIds } from "@/lib/mastodon/quote";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/timelines/home
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const minIdRaw = searchParams.get("min_id") ?? undefined;
  const minId = minIdRaw ? decodeStatusId(minIdRaw, domain) : undefined;

  const objects = await getHomeTimeline(env.DB, actor.id, limit, maxId, minId);

  const [attachmentMap, pollMap, likedIds, announcedIds, allEmojis, replyToMap, quotesCountMap, quotesById] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, objects.map((o) => o.id)),
    getLikedObjectIds(env.DB, actor.id, objects.map((o) => o.id)),
    getAnnouncedObjectIds(env.DB, actor.id, objects.map((o) => o.id)),
    getAllCustomEmojis(env.DB),
    getReplyToAccountIdMap(env.DB, objects),
    getObjectQuotesCounts(env.DB, objects.map((o) => o.id)),
    getQuotesByIds(env.DB, objects.map((o) => o.quoteId).filter(Boolean) as string[], domain),
  ]);

  const statuses = await Promise.all(
    objects.map(async (obj) => {
      let author = await getActorById(env.DB, obj.actorId);
      // Attempt a live fetch if the actor is not cached yet.
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
      if (!author) return null;
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
      });
    })
  );

  const result = statuses.filter(Boolean);

  const response = json(result);
  // Link header for pagination
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    const newest = result[0] as { id: string };
    response.headers.set("Link", buildPaginationLinks(request, oldest.id, newest.id));
  }

  return response;
}
