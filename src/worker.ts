/**
 * Cloudflare Worker entry point.
 *
 * Wraps the OpenNext Next.js worker and adds a Cloudflare Queue consumer for
 * reliable ActivityPub activity delivery with automatic retries.
 *
 * This file is used as `main` in wrangler.toml so that wrangler bundles BOTH
 * the Next.js handler (from .open-next/worker.js) and the queue consumer.
 */

// Re-export the OpenNext worker as the default fetch handler and any
// Durable Object classes it needs.
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js";
// Export the timeline streaming Durable Object
export { TimelineStreamDO } from "../lib/streaming/timeline-do";
// Export the call signaling Durable Object
export { CallSignalingDO } from "../lib/streaming/call-signaling-do";
// @ts-expect-error: generated at build time
import openNextDefault from "../.open-next/worker.js";

import type { MessageBatch, ScheduledEvent, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { APDeliveryMessage } from "../lib/activitypub/queue";
import { signRequest } from "../lib/activitypub/security";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  TIMELINE_STREAM: DurableObjectNamespace;
  CALL_SIGNALING: DurableObjectNamespace;
  CALLS_APP_ID?: string;
  CALLS_APP_SECRET?: string;
  NODE_ENV?: string;
  [key: string]: unknown;
}

// ─── Streaming WebSocket helper ───────────────────────────────────────────────

/**
 * Mastodon streaming stream names → internal DO channel names.
 * Clients connect to /api/v1/streaming?stream=<name>[&tag=<hashtag>].
 */
function resolveChannel(stream: string, tag?: string | null): string | null {
  switch (stream) {
    case "public":            return "public";
    case "public:local":      return "public:local";
    case "user":              return null; // resolved after auth
    case "hashtag":           return tag ? `hashtag:${tag.toLowerCase()}` : null;
    case "hashtag:local":     return tag ? `hashtag:local:${tag.toLowerCase()}` : null;
    default:                  return null;
  }
}

/**
 * Handle a WebSocket upgrade request for the Mastodon streaming API.
 * Routes the connection to the TimelineStreamDO after authenticating if needed.
 */
async function handleStreamingUpgrade(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const stream = url.searchParams.get("stream") ?? "public";
  const tag    = url.searchParams.get("tag");

  let channel = resolveChannel(stream, tag);

  // Authenticated home stream
  if (stream === "user") {
    const token =
      url.searchParams.get("access_token") ??
      (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return new Response("Unauthorized", { status: 401 });

    const row = await env.DB
      .prepare(
        "SELECT t.actor_id, a.username FROM oauth_tokens t JOIN actors a ON a.id = t.actor_id WHERE t.access_token = ? AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))"
      )
      .bind(token)
      .first<{ actor_id: string; username: string }>();
    if (!row?.actor_id) return new Response("Unauthorized", { status: 401 });

    channel = `home:${row.username}`;
  }

  if (!channel) return new Response("Unknown stream", { status: 400 });

  const doId = env.TIMELINE_STREAM.idFromName("timeline");
  const stub = env.TIMELINE_STREAM.get(doId);

  // Forward the original request to the DO with the resolved channel
  const doUrl = `https://timeline-do/connect?channel=${encodeURIComponent(channel)}`;
  return stub.fetch(new Request(doUrl, request));
}

const AP_CONTENT_TYPE = "application/activity+json";
const AP_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/** Permanent HTTP failure codes — don't retry, just ack. */
const PERMANENT_ERRORS = new Set([400, 401, 403, 404, 410, 422]);

async function deliverOne(
  inboxUrl: string,
  activityJson: string,
  actorId: string,
  env: Env
): Promise<{ ok: boolean; permanent: boolean }> {
  // Look up the local actor's private key
  const row = await env.DB.prepare(
    "SELECT private_key_pem FROM actors WHERE id = ? AND is_local = 1"
  )
    .bind(actorId)
    .first<{ private_key_pem: string }>();

  if (!row?.private_key_pem) {
    // Actor not found or not local — permanent failure, don't retry
    return { ok: false, permanent: true };
  }

  const keyId = `${actorId}#main-key`;
  const headers = await signRequest("POST", inboxUrl, activityJson, row.private_key_pem, keyId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": AP_CONTENT_TYPE,
        Accept: AP_ACCEPT,
        ...headers,
      },
      body: activityJson,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const permanent = PERMANENT_ERRORS.has(res.status);
    return { ok: res.ok, permanent };
  } catch {
    clearTimeout(timer);
    // Network / timeout error — transient, retry
    return { ok: false, permanent: false };
  }
}

/**
 * Route a WebSocket upgrade for call signaling to the per-call CallSignalingDO.
 * The DO is keyed by the call UUID so each call gets its own isolated relay.
 */
async function handleCallSignalingUpgrade(
  request: Request,
  env: Env,
  callId: string
): Promise<Response> {
  const doId = env.CALL_SIGNALING.idFromName(callId);
  const stub = env.CALL_SIGNALING.get(doId);
  return stub.fetch(new Request(`https://call-do/connect`, request));
}

export default {
  // Proxy all HTTP requests to the OpenNext Next.js handler,
  // but intercept WebSocket upgrades for the streaming endpoint first.
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (url.pathname === "/api/v1/streaming") {
        return handleStreamingUpgrade(request, env);
      }
      // Call signaling: /api/v1/calls/{callId}/ws
      const callMatch = url.pathname.match(/^\/api\/v1\/calls\/([0-9a-f-]{36})\/ws$/);
      if (callMatch) {
        return handleCallSignalingUpgrade(request, env, callMatch[1]);
      }
    }
    return openNextDefault.fetch(request, env, ctx);
  },

  // Queue consumer: process ActivityPub delivery jobs
  async queue(
    batch: MessageBatch<APDeliveryMessage>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      const { type, inboxUrl, activityJson, actorId } = message.body;

      if (type !== "delivery") {
        // Unknown message type — ack to discard
        message.ack();
        continue;
      }

      try {
        const { ok, permanent } = await deliverOne(
          inboxUrl,
          activityJson,
          actorId,
          env
        );
        if (ok || permanent) {
          message.ack();
        } else {
          // Transient failure (5xx, network) — let Cloudflare retry
          message.retry();
        }
      } catch {
        message.retry();
      }
    }
  },

  // Scheduled handler: auto-delete old statuses for users who have enabled it
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const rows = await env.DB
      .prepare(
        "SELECT id, auto_delete_after FROM actors WHERE is_local = 1 AND auto_delete_after IS NOT NULL AND auto_delete_after > 0"
      )
      .all<{ id: string; auto_delete_after: number }>();

    for (const row of rows.results) {
      const cutoff = new Date(Date.now() - row.auto_delete_after * 1000).toISOString();
      await env.DB
        .prepare(
          "DELETE FROM objects WHERE actor_id = ? AND published < ? AND is_local = 1 AND type = 'Note'"
        )
        .bind(row.id, cutoff)
        .run();
    }
  },
};
