import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import {
  getActorById,
  getAttachmentsByObjectIds,
  getPollsByObjectIds,
  getLikedObjectIds,
  getAnnouncedObjectIds,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import type { LocalObject } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function rowToObject(r: Row): LocalObject {
  return {
    id: r.id,
    type: r.type,
    actorId: r.actor_id,
    content: r.content ?? null,
    contentWarning: r.content_warning ?? null,
    sensitive: Boolean(r.sensitive),
    visibility: r.visibility,
    inReplyToId: r.in_reply_to_id ?? null,
    language: r.language ?? null,
    url: r.url ?? "",
    repliesCount: r.replies_count ?? 0,
    reblogsCount: r.reblogs_count ?? 0,
    favouritesCount: r.favourites_count ?? 0,
    published: r.published,
    updatedAt: r.updated_at,
    local: Boolean(r.is_local),
    raw: r.raw ?? "{}",
  };
}

// GET /api/v1/trends/statuses
// Returns the most engaged public statuses from the last 7 days.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "20"),
    40
  );

  const rows = await env.DB
    .prepare(
      `SELECT o.* FROM objects o
       WHERE o.visibility IN ('public', 'unlisted')
         AND o.type = 'Note'
         AND o.published >= datetime('now', '-7 days')
       ORDER BY (o.favourites_count + o.reblogs_count + o.replies_count) DESC,
                o.published DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<Row>();

  const objects = (rows.results ?? []).map(rowToObject);

  const authActor = await getAuthenticatedActor(request, env.DB);

  const [attachmentMap, pollMap, likedIds, announcedIds] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, objects.map((o) => o.id)),
    authActor
      ? getLikedObjectIds(env.DB, authActor.id, objects.map((o) => o.id))
      : Promise.resolve(new Set<string>()),
    authActor
      ? getAnnouncedObjectIds(env.DB, authActor.id, objects.map((o) => o.id))
      : Promise.resolve(new Set<string>()),
  ]);

  const statuses = await Promise.all(
    objects.map(async (obj) => {
      let author = await getActorById(env.DB, obj.actorId);
      if (!author && obj.actorId.startsWith("https://")) {
        try {
          const { fetchRemoteObject } = await import(
            "@/lib/activitypub/federation"
          );
          const { upsertRemoteActor } = await import("@/lib/db");
          const fetched = (await fetchRemoteObject(
            obj.actorId
          )) as import("@/lib/types").APActor | null;
          if (fetched?.publicKey?.publicKeyPem) {
            await upsertRemoteActor(env.DB, fetched);
            author = await getActorById(env.DB, obj.actorId);
          }
        } catch {
          /* ignore */
        }
      }
      if (!author) return null;
      const pollEntry = pollMap.get(obj.id);
      const poll = pollEntry
        ? serializePoll(pollEntry.poll, pollEntry.options, false, [])
        : null;
      return serializeStatus(obj, author, domain, {
        attachments: attachmentMap.get(obj.id) ?? [],
        poll,
        favourited: likedIds.has(obj.id),
        reblogged: announcedIds.has(obj.id),
      });
    })
  );

  return json(statuses.filter(Boolean));
}
