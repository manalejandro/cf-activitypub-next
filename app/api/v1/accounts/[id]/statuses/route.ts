import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, getActorStatuses, getActorStatuses_withReplies, getAttachmentsByObjectIds, getPollsByObjectIds, getLikedObjectIds, getAnnouncedObjectIds, getAllCustomEmojis, getFollow, rowToObject } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";

// GET /api/v1/accounts/:id/statuses
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const searchParams = request.nextUrl.searchParams;

  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 40);
  const maxIdRaw = searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;
  const onlyReplies = searchParams.get("only_replies") === "true";
  const pinnedOnly = searchParams.get("pinned") === "true";

  const actor = await getActorById(env.DB, decodeURIComponent(id));
  if (!actor) return notFound("Account not found");

  const me = await getAuthenticatedActor(request, env.DB);
  const isFollowing = me ? !!(await getFollow(env.DB, me.id, actor.id)) : false;

  // Fetch pinned statuses from status_pins table
  let pinnedSet = new Set<string>();
  if (pinnedOnly) {
    const pinRows = await env.DB
      .prepare(
        `SELECT sp.status_id FROM status_pins sp
         JOIN objects o ON o.id = sp.status_id
         WHERE sp.actor_id = ?
         ORDER BY sp.created_at DESC
         LIMIT ?`
      )
      .bind(actor.id, limit)
      .all<{ status_id: string }>();
    pinnedSet = new Set(pinRows.results.map((r) => r.status_id));
  }

  const objects = pinnedOnly
    ? []
    : onlyReplies
      ? await getActorStatuses_withReplies(env.DB, actor.id, limit, maxId, me?.id, isFollowing)
      : await getActorStatuses(env.DB, actor.id, limit, maxId, me?.id, isFollowing);

  // If pinnedOnly, fetch objects by the status IDs we got from status_pins
  let allObjects = objects;
  if (pinnedOnly && pinnedSet.size > 0) {
    const placeholders = [...pinnedSet].map(() => "?").join(",");
    const rowObjs = await env.DB
      .prepare(`SELECT * FROM objects WHERE id IN (${placeholders})`)
      .bind(...[...pinnedSet])
      .all<Record<string, unknown>>();
    allObjects = rowObjs.results.map(rowToObject);
  }

  const [attachmentMap, pollMap, likedIds, announcedIds, allEmojis] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, allObjects.map((o) => o.id)),
    getPollsByObjectIds(env.DB, allObjects.map((o) => o.id)),
    me ? getLikedObjectIds(env.DB, me.id, allObjects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    me ? getAnnouncedObjectIds(env.DB, me.id, allObjects.map((o) => o.id)) : Promise.resolve(new Set<string>()),
    getAllCustomEmojis(env.DB),
  ]);

  const statuses = allObjects.map((obj) => {
    const pollEntry = pollMap.get(obj.id);
    const poll = pollEntry ? serializePoll(pollEntry.poll, pollEntry.options, false, []) : null;
    return serializeStatus(obj, actor, domain, {
      attachments: attachmentMap.get(obj.id) ?? [],
      poll,
      favourited: likedIds.has(obj.id),
      reblogged: announcedIds.has(obj.id),
      emojis: allEmojis,
      pinned: pinnedOnly || pinnedSet.has(obj.id),
    });
  });

  return json(statuses);
}
