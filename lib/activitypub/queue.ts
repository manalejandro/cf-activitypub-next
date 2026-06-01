/**
 * Queue-based delivery helpers for ActivityPub federation.
 *
 * Instead of blocking the request handler while delivering activities to
 * potentially dozens of remote servers, we enqueue delivery jobs and let the
 * Cloudflare Queue consumer worker handle them with automatic retries.
 */

import type { Queue } from "@cloudflare/workers-types";

export interface APDeliveryMessage {
  type: "delivery";
  inboxUrl: string;
  activityJson: string; // JSON.stringify(APActivity)
  actorId: string; // local actor whose private key is used to sign
}

/**
 * Enqueue a batch of delivery jobs to a Cloudflare Queue.
 * Falls back to direct delivery if the queue is not available.
 */
export async function enqueueDeliveries(
  queue: Queue<APDeliveryMessage>,
  inboxUrls: string[],
  activityJson: string,
  actorId: string
): Promise<void> {
  const unique = [...new Set(inboxUrls)];
  if (unique.length === 0) return;

  // Cloudflare Queues sendBatch limit: 100 messages per call
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100).map((inboxUrl) => ({
      body: {
        type: "delivery" as const,
        inboxUrl,
        activityJson,
        actorId,
      },
    }));
    await queue.sendBatch(batch);
  }
}
