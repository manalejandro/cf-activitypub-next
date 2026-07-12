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
import { buildDelete, buildNote, generateId } from "../lib/activitypub/utils";
import { collectFollowerInboxes } from "../lib/activitypub/federation";
import { enqueueDeliveries } from "../lib/activitypub/queue";
import { broadcastDelete, broadcastHomeDelete } from "../lib/streaming/broadcast";
import { encodeStatusId } from "../lib/mastodon/statusId";
import { getActorById } from "../lib/db";
import type { APActor } from "../lib/types";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  TIMELINE_STREAM: DurableObjectNamespace;
  CALL_SIGNALING: DurableObjectNamespace;
  CALLS_TURN_KEY_ID?: string;
  CALLS_API_TOKEN?: string;
  NODE_ENV?: string;
  [key: string]: unknown;
}

// ─── Streaming WebSocket helper ───────────────────────────────────────────────

/**
 * Mastodon streaming stream names → internal DO channel names.
 * Clients connect to /api/v1/streaming?stream=<name>[&tag=<hashtag>][&list=<id>].
 *
 * `user` and `user:notification` are resolved AFTER authentication.
 * Streams that map to the same underlying channel (e.g. media variants) reuse
 * the parent channel — the DO just fans out everything and clients filter locally.
 */
function resolveChannel(
  stream: string,
  tag?: string | null,
  listId?: string | null
): string | null {
  switch (stream) {
    case "public":
    case "public:media":
      return "public";
    case "public:local":
    case "public:local:media":
      return "public:local";
    case "public:remote":
    case "public:remote:media":
      return "public:remote";
    case "user":
    case "user:notification":
      return null; // resolved after auth
    case "hashtag":
      return tag ? `hashtag:${tag.toLowerCase()}` : null;
    case "hashtag:local":
      return tag ? `hashtag:local:${tag.toLowerCase()}` : null;
    case "list":
      return listId ? `list:${listId}` : null;
    case "direct":
      return null; // resolved after auth
    default:
      return null;
  }
}

/**
 * Extract a Bearer token from the request, supporting three styles:
 *  1. `Authorization: Bearer <token>` header (preferred)
 *  2. `?access_token=<token>` query param (legacy)
 *  3. `Sec-WebSocket-Protocol: <token>` header (used by Tusky / some mobile apps)
 */
function extractToken(request: Request, url: URL): string | null {
  const authHeader = request.headers.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
  const qp = url.searchParams.get("access_token");
  if (qp) return qp;
  // Sec-WebSocket-Protocol: <token> (non-standard but widely used)
  const proto = request.headers.get("Sec-WebSocket-Protocol") ?? "";
  if (proto && !proto.includes(",")) return proto.trim();
  return null;
}

/** Resolve a token to a DB row, returning null for expired/missing tokens. */
async function resolveToken(
  db: D1Database,
  token: string
): Promise<{ actor_id: string; username: string } | null> {
  return db
    .prepare(
      "SELECT t.actor_id, a.username FROM oauth_tokens t JOIN actors a ON a.id = t.actor_id WHERE t.access_token = ? AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))"
    )
    .bind(token)
    .first<{ actor_id: string; username: string }>();
}

/**
 * Handle a WebSocket upgrade request for the Mastodon streaming API.
 * Routes the connection to the TimelineStreamDO after authenticating if needed.
 *
 * Supports:
 *  - All Mastodon stream types including user, user:notification, direct, list, hashtag variants
 *  - Multiplex connections (no ?stream= param): client subscribes via JSON after connecting
 *  - Three token auth styles: Authorization header, access_token query param, Sec-WebSocket-Protocol
 */
async function handleStreamingUpgrade(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const streamParam = url.searchParams.get("stream");
  const tag         = url.searchParams.get("tag");
  const listId      = url.searchParams.get("list");

  // ── Multiplex connection (no stream param) ────────────────────────────────
  // Client will subscribe to streams via JSON messages after connecting.
  // We need auth to determine the home channel; fall back to "public" only.
  if (!streamParam) {
    const token = extractToken(request, url);
    let channel = "public";
    if (token) {
      const row = await resolveToken(env.DB, token);
      if (!row) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
      channel = `home:${row.username}`;
    }
    return forwardToTimelineDO(env, request, channel);
  }

  // ── Authenticated streams ──────────────────────────────────────────────────
  if (streamParam === "user" || streamParam === "user:notification" || streamParam === "direct") {
    const token = extractToken(request, url);
    if (!token) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
    const row = await resolveToken(env.DB, token);
    if (!row) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });

    let channel: string;
    if (streamParam === "user:notification") {
      channel = `notification:${row.username}`;
    } else if (streamParam === "direct") {
      channel = `direct:${row.username}`;
    } else {
      // "user" → full home stream (updates + notifications)
      channel = `home:${row.username}`;
    }
    return forwardToTimelineDO(env, request, channel);
  }

  // ── List stream (requires auth) ────────────────────────────────────────────
  if (streamParam === "list") {
    if (!listId) return new Response(JSON.stringify({ error: "Missing list parameter" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const token = extractToken(request, url);
    if (!token) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
    const row = await resolveToken(env.DB, token);
    if (!row) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
    return forwardToTimelineDO(env, request, `list:${listId}`);
  }

  // ── Public / hashtag streams ───────────────────────────────────────────────
  const channel = resolveChannel(streamParam, tag, listId);
  if (!channel) {
    return new Response(JSON.stringify({ error: "Unknown channel requested" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  return forwardToTimelineDO(env, request, channel);
}

function forwardToTimelineDO(env: Env, request: Request, channel: string): Promise<Response> | Response {
  const doId = env.TIMELINE_STREAM.idFromName("timeline");
  const stub = env.TIMELINE_STREAM.get(doId);
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

async function publishDueScheduled(env: Env): Promise<{ published: number; failed: number }> {
  const dueScheduled = await env.DB
    .prepare("SELECT id, actor_id, scheduled_at, params, media_ids FROM scheduled_statuses WHERE scheduled_at <= datetime('now') OR replace(scheduled_at, 'T', ' ') <= datetime('now')")
    .all<{ id: string; actor_id: string; scheduled_at: string; params: string; media_ids: string | null }>();

  let publishedCount = 0;
  let failedCount = 0;

  for (const s of dueScheduled.results) {
    try {
      const body = JSON.parse(s.params) as Record<string, unknown>;
      body.scheduled_at = undefined;
      const actor = await getActorById(env.DB, s.actor_id);
      if (!actor || !actor.privateKeyPem) continue;

      const baseUrl = `https://${actor.domain}`;
      const content = (body.status as string | undefined)?.trim() ?? "";
      const visibility = (body.visibility as string) ?? "public";
      const sensitive = body.sensitive === true || body.sensitive === "true";
      const spoilerText = (body.spoiler_text as string | undefined) ?? "";
      const language = body.language as string | undefined;
      const published = new Date().toISOString();
      const noteId = generateId();

      const note = buildNote(baseUrl, noteId, {
        actorUsername: actor.username,
        content,
        published,
        visibility: visibility as "public" | "unlisted" | "followers" | "direct",
        inReplyTo: undefined,
        sensitive,
        summary: sensitive ? spoilerText : undefined,
        language,
        tags: [],
      });

      await env.DB
        .prepare("INSERT INTO objects (id, type, actor_id, content, content_warning, sensitive, visibility, in_reply_to_id, language, url, replies_count, reblogs_count, favourites_count, published, is_local, raw) VALUES (?, 'Note', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 1, ?)")
        .bind(note.id, s.actor_id, content, sensitive ? spoilerText : null, sensitive ? 1 : 0, visibility, null, language ?? null, note.url ?? note.id, published, JSON.stringify(note))
        .run();

      await env.DB
        .prepare("UPDATE actors SET statuses_count = statuses_count + 1 WHERE id = ?")
        .bind(s.actor_id)
        .run();

      await env.DB
        .prepare("DELETE FROM scheduled_statuses WHERE id = ?")
        .bind(s.id)
        .run();

      publishedCount++;
    } catch (e) {
      console.error("[scheduled] Failed to publish scheduled status", s.id, e);
      failedCount++;
    }
  }

  return { published: publishedCount, failed: failedCount };
}

export default {
  // Proxy all HTTP requests to the OpenNext Next.js handler,
  // but intercept streaming and WebSocket endpoints first.
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // ── WebSocket upgrades ────────────────────────────────────────────────────
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
          message.retry();
        }
      } catch {
        message.retry();
      }
    }
  },

  // Scheduled handler: auto-delete old statuses for users who have enabled it
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await publishDueScheduled(env);

    const actors = await env.DB
      .prepare(
        "SELECT id, auto_delete_after FROM actors WHERE is_local = 1 AND auto_delete_after IS NOT NULL AND auto_delete_after > 0"
      )
      .all<{ id: string; auto_delete_after: number }>();

    for (const actor of actors.results) {
      const cutoff = new Date(Date.now() - actor.auto_delete_after * 1000).toISOString();

      // First, SELECT the objects that will be deleted so we can federate the deletions
      const objects = await env.DB
        .prepare(
          "SELECT id, visibility FROM objects WHERE actor_id = ? AND published < ? AND is_local = 1 AND type = 'Note'"
        )
        .bind(actor.id, cutoff)
        .all<{ id: string; visibility: string }>();

      if (objects.results.length === 0) continue;

      const localActor = await getActorById(env.DB, actor.id);
      if (!localActor) continue;

      // Federate Delete activities to remote followers
      if (localActor.privateKeyPem) {
        const baseUrl = `https://${localActor.domain}`;

        const followers = await env.DB
          .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
          .bind(actor.id)
          .all<{ actor_id: string }>();

        const followerIds = followers.results.map((r) => r.actor_id);

        if (followerIds.length > 0) {
          const fetchActor = async (id: string): Promise<APActor | null> => {
            const cached = await getActorById(env.DB, id);
            return cached as unknown as APActor | null;
          };
          const inboxes = await collectFollowerInboxes(followerIds, fetchActor);

          if (inboxes.length > 0) {
            for (const obj of objects.results) {
              const deleteActivity = buildDelete(baseUrl, localActor.id, obj.id, generateId());
              await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(deleteActivity), localActor.id);
            }
          }
        }
      }

      // Broadcast streaming delete events to local clients
      if (env.TIMELINE_STREAM) {
        const broadcastTasks: Promise<void>[] = [];

        for (const obj of objects.results) {
          const encodedStatusId = encodeStatusId(obj.id, true);
          const isPublic = obj.visibility === "public";
          broadcastTasks.push(
            broadcastDelete(env.TIMELINE_STREAM, encodedStatusId, isPublic, true),
            broadcastHomeDelete(env.TIMELINE_STREAM, localActor.id, encodedStatusId),
          );
        }

        const localFollowerRows = await env.DB
          .prepare("SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1")
          .bind(actor.id)
          .all<{ id: string }>();

        for (const obj of objects.results) {
          const encodedStatusId = encodeStatusId(obj.id, true);
          for (const follower of localFollowerRows.results) {
            broadcastTasks.push(broadcastHomeDelete(env.TIMELINE_STREAM, follower.id, encodedStatusId));
          }
        }

        await Promise.allSettled(broadcastTasks);
      }

      // Finally, delete the objects from DB
      await env.DB
        .prepare(
          "DELETE FROM objects WHERE actor_id = ? AND published < ? AND is_local = 1 AND type = 'Note'"
        )
        .bind(actor.id, cutoff)
        .run();
    }
  },
};
