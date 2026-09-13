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

// Cloudflare Queues limits: 100 messages and 256 KB per sendBatch call, 128 KB
// per message. Bits of headroom keep serialization metadata from tripping them.
const MAX_MESSAGES = 100;
const MAX_BATCH_BYTES = 200 * 1024;
const MAX_MESSAGE_BYTES = 120 * 1024;
const SEND_ATTEMPTS = 3;

/**
 * Enqueue a batch of delivery jobs to a Cloudflare Queue.
 *
 * Every recipient is sent even when the fan-out is larger than one sendBatch:
 * the list is chunked by message count *and* byte budget, and each chunk is
 * retried a few times. Only the chunk that keeps failing (or a message too big
 * to fit in a queue message) falls back to direct delivery — never the whole
 * recipient list, so already-queued chunks aren't duplicated and the direct
 * work stays bounded.
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

  if (!queue) {
    await deliverDirectly(unique, activityJson, keyId, privateKeyPem);
    return;
  }

  const encoder = new TextEncoder();
  const sendChunk = async (chunk: { body: APDeliveryMessage }[]): Promise<void> => {
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        await queue.sendBatch(chunk);
        return;
      } catch (err) {
        if (attempt === SEND_ATTEMPTS) {
          console.warn(
            `[queue] sendBatch failed after ${SEND_ATTEMPTS} attempts for ${chunk.length} inboxes, delivering directly`,
            err
          );
          await deliverDirectly(chunk.map((m) => m.body.inboxUrl), activityJson, keyId, privateKeyPem);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  };

  let batch: { body: APDeliveryMessage }[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const chunk = batch;
    batch = [];
    batchBytes = 0;
    await sendChunk(chunk);
  };

  try {
    for (const inboxUrl of unique) {
      const message = { body: { type: "delivery" as const, inboxUrl, activityJson, actorId } };
      const size = encoder.encode(JSON.stringify(message)).byteLength;

      // A single message over the 128 KB queue limit can never be enqueued.
      if (size > MAX_MESSAGE_BYTES) {
        await flush();
        await deliverDirectly([inboxUrl], activityJson, keyId, privateKeyPem);
        continue;
      }
      if (batch.length > 0 && (batch.length >= MAX_MESSAGES || batchBytes + size > MAX_BATCH_BYTES)) {
        await flush();
      }
      batch.push(message);
      batchBytes += size;
    }
    await flush();
  } catch (err) {
    // Unexplained failure: only the messages still in the current batch are
    // unsent, so deliver those directly instead of the whole list.
    console.warn("[queue] enqueueDeliveries failed, delivering the pending chunk directly", err);
    const pending = batch.map((m) => m.body.inboxUrl);
    if (pending.length > 0) await deliverDirectly(pending, activityJson, keyId, privateKeyPem);
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
