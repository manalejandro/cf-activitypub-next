import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getHashtagTimeline, getActorById, getAttachmentsByObjectIds, getPollsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

// GET /api/v1/timelines/tag/:hashtag
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hashtag: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const { hashtag } = await params;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 40);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;

  const objects = await getHashtagTimeline(env.DB, hashtag, limit, maxId);

  const authActor = await getAuthenticatedActor(request, env.DB);

  const [attachmentMap, pollMap, likedIds, announcedIds] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, objects.map((o) => o.id)),
    authActor ? getLikedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    authActor ? getAnnouncedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
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
      });
    })
  );

  const result = statuses.filter(Boolean);

  const response = json(result);
  if (result.length > 0) {
    const oldest = result[result.length - 1] as { id: string };
    response.headers.set(
      "Link",
      `<${request.url.split("?")[0]}?max_id=${oldest.id}>; rel="next"`
    );
  }

  return response;
}
