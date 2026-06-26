import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getPublicTimeline, getActorById, getAttachmentsByObjectIds, getPollsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

// GET /api/v1/timelines/public
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 40);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const sinceIdRaw = searchParams.get("since_id") ?? undefined;
  const sinceId = sinceIdRaw ? decodeStatusId(sinceIdRaw, domain) : undefined;
  const local = searchParams.get("local") === "true";

  const authActor = await getAuthenticatedActor(request, env.DB);
  const objects = await getPublicTimeline(env.DB, limit, maxId, local, sinceId);

  const [attachmentMap, pollMap, likedIds, announcedIds] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, objects.map((o) => o.id)),
    authActor ? getLikedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    authActor ? getAnnouncedObjectIds(env.DB, authActor.id, objects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
  ]);

  const statuses = await Promise.all(
    objects.map(async (obj) => {
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