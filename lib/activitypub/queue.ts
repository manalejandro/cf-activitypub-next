/**
 * Queue-based delivery helpers for ActivityPub federation.
 *
 * Instead of blocking the request handler while delivering activities to
 * potentially dozens of remote servers, we enqueue delivery jobs and let the
 * Cloudflare Queue consumer worker handle them with automatic retries.
 */

import type { Queue } from "@cloudflare/workers-types";
import type { APActivity } from "@/lib/types";
import { deliverToInbox } from "./federation";

export interface APDeliveryMessage {
  type: "delivery";
  inboxUrl: string;
  activityJson: string; // JSON.stringify(APActivity)
  actorId: string; // local actor whose private key is used to sign
}

/**
 * Enqueue a batch of delivery jobs to a Cloudflare Queue.
 *
 * Falls back to direct, synchronous delivery when the queue binding is missing
 * or `sendBatch` throws (e.g. local dev, queue at capacity). This guarantees the
 * activity still reaches its recipients instead of being silently dropped after
 * the status was already persisted.
 */
export async function enqueueDeliveries(
  queue: Queue<APDeliveryMessage> | undefined | null,
  inboxUrls: string[],
  activityJson: string,
  actorId: string,
  keyId?: string,
  privateKeyPem?: string | null
): Promise<void> {
  const unique = [...new Set(inboxUrls)];
  if (unique.length === 0) return;

  try {
    if (!queue) {
      await deliverDirectly(unique, activityJson, keyId, privateKeyPem);
      return;
    }
    // Cloudflare Queues sendBatch limits: 100 messages and ~256 KB total per
    // call. The activity JSON is repeated on every message, so a large status
    // plus many recipients can blow the byte budget long before 100 messages.
    // Chunk by both message count and estimated batch size.
    const MAX_MESSAGES = 100;
    const MAX_BATCH_BYTES = 200 * 1024; // headroom under the 256000 byte limit
    const encoder = new TextEncoder();

    let batch: { body: APDeliveryMessage }[] = [];
    let batchBytes = 0;
    for (const inboxUrl of unique) {
      const message = { body: { type: "delivery" as const, inboxUrl, activityJson, actorId } };
      const size = encoder.encode(JSON.stringify(message)).byteLength;
      if (batch.length > 0 && (batch.length >= MAX_MESSAGES || batchBytes + size > MAX_BATCH_BYTES)) {
        await queue.sendBatch(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(message);
      batchBytes += size;
    }
    if (batch.length > 0) await queue.sendBatch(batch);
  } catch (err) {
    console.warn("[queue] enqueueDeliveries failed, falling back to direct delivery", err);
    await deliverDirectly(unique, activityJson, keyId, privateKeyPem);
  }
}

async function deliverDirectly(
  inboxUrls: string[],
  activityJson: string,
  keyId?: string,
  privateKeyPem?: string | null
): Promise<void> {
  if (!keyId || !privateKeyPem) return;
  let activity: APActivity;
  try {
    activity = JSON.parse(activityJson) as APActivity;
  } catch {
    return;
  }
  await Promise.allSettled(
    inboxUrls.map((inboxUrl) => deliverToInbox(inboxUrl, activity, keyId, privateKeyPem))
  );
}
