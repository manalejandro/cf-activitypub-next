import type { D1Database } from "@cloudflare/workers-types";
import type { LocalActor, LocalObject } from "@/lib/types";
import { getActorById } from "@/lib/db";
import { serializeReblog } from "@/lib/mastodon/serializers";
import { encodeStatusId } from "@/lib/mastodon/statusId";
import { serializeStatusForStream } from "@/lib/streaming/serialize";
import {
  broadcastHomeStatus,
  eligibleLocalRecipients,
  parentExclusion,
  type DONamespace,
} from "@/lib/streaming/broadcast";

/**
 * Broadcast a new boost to the home feeds of the booster's local followers
 * (and the booster's own), so a live boost shows up without a timeline reload.
 * Followers-only/direct originals are skipped — their visibility is resolved by
 * the timeline query, not by the fan-out — and recipients who blocked the
 * booster, the original author or the original's parent (or their domains) are
 * left out, mirroring the query.
 *
 * The wrapper carries the original's full payload (media, poll, quote): for
 * followers who do not follow the original author the boost is their first view
 * of the status, so a bare wrapper rendered without images. Both the federated
 * path (handleAnnounce) and the local reblog route go through here.
 */
export async function broadcastNewBoostToFollowers(
  db: D1Database,
  ns: DONamespace | null | undefined,
  booster: LocalActor,
  obj: LocalObject,
  announceId: string,
  createdAt: string,
  localDomain: string
): Promise<void> {
  if (!ns || obj.mediaPending) return;
  if (obj.visibility !== "public" && obj.visibility !== "unlisted") return;
  try {
    const author = await getActorById(db, obj.actorId);
    if (!author) return;
    const original = await serializeStatusForStream(db, obj, author, localDomain);
    const wrapper = serializeReblog(booster, original, {
      id: encodeStatusId(announceId, true),
      createdAt,
      localDomain,
    });
    const followers = await db
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(booster.id)
      .all<{ actor_id: string }>();
    const recipients = [booster.id, ...(followers.results ?? []).map((r) => r.actor_id)];
    const parent = await parentExclusion(db, obj.inReplyToId);
    const exclusions: { id: string; domain: string | null }[] = [
      { id: booster.id, domain: booster.domain },
      { id: author.id, domain: author.domain },
    ];
    if (parent) exclusions.push(parent);
    const localIds = await eligibleLocalRecipients(db, recipients, exclusions);
    await Promise.all(localIds.map((id) => broadcastHomeStatus(ns, id, wrapper)));
  } catch { /* streaming is best-effort */ }
}
