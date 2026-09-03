import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, getAttachmentsByObjectId, getAllCustomEmojis,
  getLastStatusAtMap} from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { resolveLimits } from "@/lib/constants";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(_request.url).hostname;
  const rawId = (await params).id;
  const id = decodeStatusId(rawId, domain);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const obj = await getObjectById(env.DB, id);
  if (!obj) return notFound();
  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound();
  const existing = await env.DB
    .prepare("SELECT id FROM status_pins WHERE actor_id = ? AND status_id = ?")
    .bind(me.id, id)
    .first<{ id: string }>();
  if (!existing) {
    // Enforce the pinned-statuses limit reported by the instance. Only count
    // pins whose status still exists — dangling pins (deleted statuses) must
    // not consume the quota.
    const pinCount = await env.DB
      .prepare(
        "SELECT COUNT(*) AS c FROM status_pins sp JOIN objects o ON o.id = sp.status_id WHERE sp.actor_id = ?"
      )
      .bind(me.id)
      .first<{ c: number }>();
    if (Number(pinCount?.c ?? 0) >= limits.maxPinnedStatuses) {
      return json({ error: `Validation failed: You have already pinned the maximum number of statuses (${limits.maxPinnedStatuses})` }, 422);
    }
    const pinId = `pin_${id}_${me.id}`;
    await env.DB
      .prepare("INSERT INTO status_pins (id, actor_id, status_id) VALUES (?, ?, ?)")
      .bind(pinId, me.id, id)
      .run();
  }
  const [attachments, allEmojis] = await Promise.all([
    getAttachmentsByObjectId(env.DB, id),
    getAllCustomEmojis(env.DB),
  ]);
    const authorLastStatusAt = (await getLastStatusAtMap(env.DB, [obj.actorId])).get(obj.actorId) ?? null;
  const authorExtras = (await getStatusAuthorExtras(env.DB, [obj.actorId], domain)).get(obj.actorId);
  return json(serializeStatus(obj, author, domain, { pinned: true, attachments, emojis: allEmojis, authorLastStatusAt, authorSupportsCalls: authorExtras?.supportsCalls, authorMoved: authorExtras?.moved ?? null }));
}
