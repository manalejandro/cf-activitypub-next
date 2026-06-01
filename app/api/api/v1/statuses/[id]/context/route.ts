import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getObjectById, getActorById } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import type { LocalObject, LocalActor } from "@/lib/types";

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

  // ── Ancestors: walk up inReplyToId chain ──────────────────────────────────
  const ancestorObjs: LocalObject[] = [];
  let current: LocalObject | null = focal;
  while (current?.inReplyToId) {
    const parent = await getObjectById(env.DB, current.inReplyToId);
    if (!parent) break;
    ancestorObjs.unshift(parent); // prepend so oldest is first
    current = parent;
    if (ancestorObjs.length >= 20) break; // safety cap
  }

  // ── Descendants: BFS from this status ────────────────────────────────────
  const descendantObjs: LocalObject[] = [];
  const queue: string[] = [statusId];
  const seen = new Set<string>([statusId]);

  while (queue.length > 0 && descendantObjs.length < 50) {
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

  const serializeAll = async (objs: LocalObject[]) =>
    (
      await Promise.all(
        objs.map(async (obj) => {
          const author = await getAuthor(obj.actorId);
          if (!author) return null;
          return serializeStatus(obj, author, domain);
        })
      )
    ).filter(Boolean);

  const [ancestors, descendants] = await Promise.all([
    serializeAll(ancestorObjs),
    serializeAll(descendantObjs),
  ]);

  return json({ ancestors, descendants });
}
