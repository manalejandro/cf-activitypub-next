import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getObjectById, getActorById, getPollsByObjectIds, getAttachmentsByObjectIds, getAllCustomEmojis, getFollow, canViewStatus, getReplyToAccountId, getLastStatusAtMap , getBookmarkedObjectIds , getActorFieldsMap } from "@/lib/db";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { getAuthenticatedActor } from "@/lib/auth";
import type { LocalObject, LocalActor } from "@/lib/types";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { MAX_THREAD_ANCESTORS, MAX_THREAD_DESCENDANTS } from "@/lib/constants";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

// GET /api/v1/statuses/:id/context
// Returns { ancestors: Status[], descendants: Status[] }
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const statusId = decodeStatusId(id, domain);

  const focal = await getObjectById(env.DB, statusId);
  if (!focal) return notFound("Status not found");

  const authActor = await getAuthenticatedActor(request, env.DB);
  const isFollowingFocal = authActor ? !!(await getFollow(env.DB, authActor.id, focal.actorId)) : false;
  if (!canViewStatus(focal, authActor?.id ?? null, isFollowingFocal)) {
    return notFound("Record not found");
  }

  // ── Ancestors: walk up inReplyToId chain ──────────────────────────────────
  const ancestorObjs: LocalObject[] = [];
  let current: LocalObject | null = focal;
  while (current?.inReplyToId) {
    const parent = await getObjectById(env.DB, current.inReplyToId);
    if (!parent) break;
    ancestorObjs.unshift(parent); // prepend so oldest is first
    current = parent;
    if (ancestorObjs.length >= MAX_THREAD_ANCESTORS) break; // safety cap
  }

  // ── Descendants: BFS from this status ────────────────────────────────────
  const descendantObjs: LocalObject[] = [];
  const queue: string[] = [statusId];
  const seen = new Set<string>([statusId]);

  while (queue.length > 0 && descendantObjs.length < MAX_THREAD_DESCENDANTS) {
    const parentId = queue.shift()!;
    const rows = await env.DB
      .prepare("SELECT * FROM objects WHERE in_reply_to_id = ? ORDER BY published ASC LIMIT 20")
      .bind(parentId)
      .all<Record<string, unknown>>();

    for (const row of rows.results) {
      const childId = row.id as string;
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = await getObjectById(env.DB, childId);
      if (child) {
        descendantObjs.push(child);
        queue.push(childId);
      }
    }
  }

  // ── Serialize all objects ─────────────────────────────────────────────────
  const actorCache = new Map<string, LocalActor | null>();

  async function getAuthor(actorId: string): Promise<LocalActor | null> {
    if (actorCache.has(actorId)) return actorCache.get(actorId)!;
    const actor = await getActorById(env.DB, actorId);
    actorCache.set(actorId, actor);
    return actor;
  }

  async function canView(obj: LocalObject): Promise<boolean> {
    const viewerId = authActor?.id ?? null;
    if (viewerId === null) return obj.visibility === "public" || obj.visibility === "unlisted";
    if (viewerId === obj.actorId) return true;
    const isFollower = !!(await getFollow(env.DB, viewerId, obj.actorId));
    return canViewStatus(obj, viewerId, isFollower);
  }

  const serializeAll = async (objs: LocalObject[]) => {
    const [pollMap, attachmentMap, allEmojis, filteredMap, lastStatusAtMap, bookmarkedIds] = await Promise.all([
      getPollsByObjectIds(env.DB, objs.map((o) => o.id)),
      objs.length > 0 ? getAttachmentsByObjectIds(env.DB, objs.map((o) => o.id)) : Promise.resolve(new Map()),
      getAllCustomEmojis(env.DB),
      authActor
        ? getFilterResultsForStatuses(env.DB, authActor.id, objs)
        : Promise.resolve(new Map()),
      getLastStatusAtMap(env.DB, objs.map((o) => o.actorId)),
      authActor ? getBookmarkedObjectIds(env.DB, authActor.id, objs.map((o) => o.id)) : Promise.resolve(new Set()),
    ]);
    const authorExtras = await getStatusAuthorExtras(env.DB, objs.map((o) => o.actorId), domain);
    const authorFieldsMap = await getActorFieldsMap(env.DB, objs.map((o) => o.actorId));
    return (
      await Promise.all(
        objs.map(async (obj) => {
          if (!(await canView(obj))) return null;
          const author = await getAuthor(obj.actorId);
          if (!author) return null;
          const pollEntry = pollMap.get(obj.id);
          const poll = pollEntry ? serializePoll(pollEntry.poll, pollEntry.options, false, []) : null;
          const inReplyToAccountId = await getReplyToAccountId(env.DB, obj);
          return serializeStatus(obj, author, domain, { poll, attachments: attachmentMap.get(obj.id) ?? [], emojis: allEmojis, inReplyToAccountId, filtered: filteredMap.get(obj.id) ?? [], authorLastStatusAt: lastStatusAtMap.get(obj.actorId) ?? null, authorSupportsCalls: authorExtras.get(obj.actorId)?.supportsCalls, authorMoved: authorExtras.get(obj.actorId)?.moved ?? null, bookmarked: bookmarkedIds.has(obj.id), authorFields: authorFieldsMap.get(obj.actorId) ?? [] });
        })
      )
    ).filter(Boolean);
  };

  const [ancestors, descendants] = await Promise.all([
    serializeAll(ancestorObjs),
    serializeAll(descendantObjs),
  ]);

  return json({ ancestors, descendants });
}
