import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getHashtagTimeline, getActorById, getAttachmentsByObjectIds, getPollsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds, getAllCustomEmojis, getReplyToAccountIdMap } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { buildPaginationLinks } from "@/lib/mastodon/pagination";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/timelines/tag/:hashtag
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hashtag: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;
  const { hashtag } = await params;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? String(limits.defaultTimelinePage)), limits.maxPageSize);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const sinceIdRaw = searchParams.get("since_id") ?? undefined;
  const sinceId = sinceIdRaw ? decodeStatusId(sinceIdRaw, domain) : undefined;

  const authActor = await getAuthenticatedActor(request, env.DB);

  const objects = await getHashtagTimeline(env.DB, hashtag, limit, maxId, sinceId, authActor?.id ?? undefined);

  const [attachmentMap, pollMap, likedIds, announcedIds, allEmojis, replyToMap] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, objects.map((o) => o.id)),
    authActor ? getLikedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    authActor ? getAnnouncedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    getAllCustomEmojis(env.DB),
    getReplyToAccountIdMap(env.DB, objects),
  ]);

  const statuses = await Promise.all(
    objects.map(async (obj) => {
      let author = await getActorById(env.DB, obj.actorId);
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
