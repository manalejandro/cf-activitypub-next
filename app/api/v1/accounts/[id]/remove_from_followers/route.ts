import { type NextRequest } from "next/server";
import { getBaseUrl, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getFollow } from "@/lib/db";
import { buildFollow, buildReject, generateId } from "@/lib/activitypub/utils";
import { fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { APActor } from "@/lib/types";
import { env } from "cloudflare:workers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const target = await getActorById(env.DB, rawId);
  if (!target) return json({ error: "Not found" }, 404);
  // The original Follow is needed for the Reject below.
  const follow = await getFollow(env.DB, rawId, me.id);
  const removed = await env.DB
    .prepare("DELETE FROM follows WHERE actor_id = ? AND target_id = ? AND state = 'accepted'")
    .bind(rawId, me.id)
    .run();

  // Mastodon's RemoveFromFollowersService: a **remote** account that is removed
  // from the followers learns it with a `Reject{Follow}` sent to its personal
  // inbox (not the shared one), through the delivery queue like every other
  // outbound activity. A local follower needs nothing (the follow is gone here).
  if ((removed.meta?.changes ?? 0) > 0 && follow && !target.isLocal && me.privateKeyPem) {
    const baseUrl = getBaseUrl(env);
    const followActivity = buildFollow(baseUrl, rawId, me.id, follow.id);
    const rejectActivity = buildReject(baseUrl, me.id, {
      ...followActivity,
      id: follow.activityId ?? followActivity.id,
    }, generateId());

    let inbox = target.inbox ?? null;
    if (!inbox) {
      inbox = ((await fetchRemoteObject(target.id).catch(() => null)) as APActor | null)?.inbox ?? null;
    }
    if (inbox) {
      await enqueueDeliveries(
        env.DELIVERY_QUEUE,
        [inbox],
        JSON.stringify(rejectActivity),
        me.id,
        `${me.id}#main-key`,
        me.privateKeyPem
      );
    }
  }
  return json({ id: rawId, following: false, showing_reblogs: false, notifying: false, followed_by: false, blocking: false, blocked_by: false, muting: false, muting_notifications: false, requested: false, domain_blocking: false, endorsed: false, note: "" });
}
