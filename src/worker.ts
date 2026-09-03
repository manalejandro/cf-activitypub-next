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
import openNextDefault from "../.open-next/worker.js";

import type { MessageBatch, ScheduledEvent } from "@cloudflare/workers-types";
import type { APDeliveryMessage } from "../lib/activitypub/queue";
import { signRequest } from "../lib/activitypub/security";
import { buildDelete, buildNote, generateId } from "../lib/activitypub/utils";
import { collectFollowerInboxes, validateOutboundUrl } from "../lib/activitypub/federation";
import { enqueueDeliveries } from "../lib/activitypub/queue";
import { broadcastDelete, broadcastHomeDelete } from "../lib/streaming/broadcast";
import type { DONamespace } from "../lib/streaming/broadcast";
import { encodeStatusId } from "../lib/mastodon/statusId";
import { getActorById } from "../lib/db";
import { verifyAccountFields } from "../lib/activitypub/verification";
import { runModerationCycle } from "../lib/moderation/cycle";
import type { APActor } from "../lib/types";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  DELIVERY_QUEUE: Queue;
  ASSETS: Fetcher;
  TIMELINE_STREAM: DONamespace;
  CALL_SIGNALING: CallSignalingNamespace;
  CALLS_TURN_KEY_ID?: string;
  CALLS_API_TOKEN?: string;
  NODE_ENV?: string;
  [key: string]: unknown;
}

/** Structural type for the call signaling Durable Object binding (avoids
 *  @cloudflare/workers-types version mismatches — same shape as broadcast's
 *  DONamespace). */
type CallSignalingNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string | URL, init?: RequestInit): Promise<Response> };
};

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
  // Cookie-based auth
  const cookie = request.headers.get("Cookie");
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// ─── WebSocket abuse protection (Origin + per-IP connect limits) ─────────────
//
// Protects the streaming endpoint against unauthenticated external connections:
//  1. Cross-Site WebSocket Hijacking — browsers always send an `Origin` header
//     on a WebSocket handshake. Connections from a foreign Origin are rejected
//     unless they carry an explicit credential (Bearer/query/Sec-WebSocket-
//     Protocol token) that a cross-site script could never obtain. The web UI's
//     own connections are same-origin (or localhost), so they pass untouched.
//  2. Per-IP connection churn — anonymous/public sockets are capped by the DO,
//     but nothing stops an IP from hammering the upgrade endpoint. A KV-backed
//     sliding window rate-limits upgrade attempts; an IP that exceeds the limit
//     is temporarily blocked so its requests are rejected before reaching the DO.

const WS_CONNECT_WINDOW_SEC = 60;
const WS_MAX_CONNECTS_PER_WINDOW = 30;
const WS_BLOCK_TTL_SEC = 5 * 60;

/** True when the request carries an explicit (non-cookie) credential. */
function hasExplicitCredential(request: Request, url: URL): boolean {
  const authHeader = request.headers.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) return true;
  if (url.searchParams.get("access_token")) return true;
  const proto = request.headers.get("Sec-WebSocket-Protocol") ?? "";
  if (proto && !proto.includes(",")) return true;
  return false;
}

/**
 * Validate the WebSocket handshake's Origin header. Returns an error message to
 * reject with, or null when the connection may proceed. Cross-origin browser
 * connections are only allowed when an explicit token credential is present.
 */
function validateWsOrigin(request: Request, url: URL): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null; // non-browser client (native app, curl, …)

  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return "Malformed Origin header";
  }

  const devHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (devHosts.has(originHost)) return null;

  const hostHeader = request.headers.get("Host") ?? url.host;
  const expectedHost = (hostHeader.split(":")[0] || "").toLowerCase();
  if (originHost === expectedHost) return null;

  // Cross-origin: only trust it when an explicit credential proves intent.
  if (hasExplicitCredential(request, url)) return null;
  return "Cross-origin WebSocket connections are not allowed";
}

/** Whether the given IP is currently blocked from opening WebSockets. */
async function isWsIpBlocked(kv: KVNamespace, ip: string): Promise<boolean> {
  return (await kv.get(`ws_block:${ip}`)) !== null;
}

/**
 * Record a WebSocket upgrade attempt from this IP. Returns false (and blocks the
 * IP) once the IP exceeds the allowed connection-attempt rate. Uses a sliding
 * window keyed on `floor(now/window)` with a TTL slightly longer than the window
 * so the counter is always present for the whole window it covers.
 */
async function enforceWsConnectRateLimit(
  kv: KVNamespace,
  ip: string
): Promise<{ allowed: boolean; blocked: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `ws_conn:${ip}:${Math.floor(now / WS_CONNECT_WINDOW_SEC)}`;
  const count = parseInt((await kv.get(windowKey)) ?? "0", 10);
  if (count >= WS_MAX_CONNECTS_PER_WINDOW) {
    await kv.put(`ws_block:${ip}`, "1", { expirationTtl: WS_BLOCK_TTL_SEC });
    return { allowed: false, blocked: true };
  }
  await kv.put(windowKey, String(count + 1), { expirationTtl: WS_CONNECT_WINDOW_SEC + 5 });
  return { allowed: true, blocked: false };
}

/** Resolve a token to a DB row, returning null for expired/missing tokens. */
async function resolveToken(
  db: D1Database,
  token: string
): Promise<{ actor_id: string; username: string } | null> {
  // expires_at is stored ISO-8601; compare against an ISO "now" (datetime('now')
  // uses a space format and would keep a token valid for up to a day past
  // its expiry).
  const nowIso = new Date().toISOString();
  return db
    .prepare(
      "SELECT t.actor_id, a.username FROM oauth_tokens t JOIN actors a ON a.id = t.actor_id WHERE t.access_token = ? AND (t.expires_at IS NULL OR t.expires_at > ?)"
    )
    .bind(token, nowIso)
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

  // ── Abuse protection (blocked IPs, cross-site hijacking, churn) ─────────────
  // Runs on every upgrade attempt, before any auth resolution or DO hop.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (await isWsIpBlocked(env.KV, ip)) {
    return new Response(JSON.stringify({ error: "Source IP temporarily blocked" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const originError = validateWsOrigin(request, url);
  if (originError) {
    return new Response(JSON.stringify({ error: originError }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const rl = await enforceWsConnectRateLimit(env.KV, ip);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: rl.blocked ? "Source IP temporarily blocked" : "Too many connection attempts" }),
      { status: rl.blocked ? 403 : 429, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Multiplex connection (no stream param) ────────────────────────────────
  // Client will subscribe to streams via JSON messages after connecting.
  // We need auth to determine the home channel; fall back to "public" only.
  if (!streamParam) {
    const token = extractToken(request, url);
    let channel = "public";
    let authed = false;
    if (token) {
      const row = await resolveToken(env.DB, token);
      if (!row) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
      channel = `home:${row.username}`;
      authed = true;
    }
    return forwardToTimelineDO(env, request, channel, authed);
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
    return forwardToTimelineDO(env, request, channel, true);
  }

  // ── List stream (requires auth) ────────────────────────────────────────────
  if (streamParam === "list") {
    if (!listId) return new Response(JSON.stringify({ error: "Missing list parameter" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const token = extractToken(request, url);
    if (!token) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
    const row = await resolveToken(env.DB, token);
    if (!row) return new Response(JSON.stringify({ error: "The access token is invalid" }), { status: 401, headers: { "Content-Type": "application/json" } });
    return forwardToTimelineDO(env, request, `list:${listId}`, true);
  }

  // ── Public / hashtag streams ───────────────────────────────────────────────
  const channel = resolveChannel(streamParam, tag, listId);
  if (!channel) {
    return new Response(JSON.stringify({ error: "Unknown channel requested" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The web UI's timelines page connects to public streams even while logged
  // in. Resolve the token so those are treated as authenticated (normal
  // concurrent limit, no forced session timeout) instead of anonymous.
  const token = extractToken(request, url);
  let authed = false;
  if (token) {
    const row = await resolveToken(env.DB, token);
    authed = Boolean(row);
  }
  return forwardToTimelineDO(env, request, channel, authed);
}

function forwardToTimelineDO(env: Env, request: Request, channel: string, authed = false): Promise<Response> | Response {
  const doId = env.TIMELINE_STREAM.idFromName("timeline");
  const stub = env.TIMELINE_STREAM.get(doId);
  const doUrl = `https://timeline-do/connect?channel=${encodeURIComponent(channel)}&authed=${authed ? 1 : 0}`;
  // Forward the upgrade request to the Durable Object. Rebuilding the request
  // from its method + headers (instead of reusing the original Request object)
  // keeps the DOM/workers-types globals from colliding in type checking.
  return stub.fetch(doUrl, { method: request.method, headers: request.headers }) as Promise<Response>;
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
  // SSRF guard: inbox URLs originate from remote actor documents / user input.
  // Never POST to non-HTTPS, private, or local addresses.
  const validation = validateOutboundUrl(inboxUrl);
  if (!validation.valid) {
    console.warn(`[worker] Blocked delivery to ${inboxUrl}: ${validation.reason}`);
    return { ok: false, permanent: true };
  }

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
    // We only need the status; cancel the body so concurrent deliveries don't
    // stall on unread responses (Cloudflare deadlock protection).
    await res.body?.cancel().catch(() => {});
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
  const url = new URL(request.url);

  // ── Abuse protection (same hardening as the streaming upgrades) ───────────
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (await isWsIpBlocked(env.KV, ip)) {
    return new Response(JSON.stringify({ error: "Source IP temporarily blocked" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const originError = validateWsOrigin(request, url);
  if (originError) {
    return new Response(JSON.stringify({ error: originError }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const rl = await enforceWsConnectRateLimit(env.KV, ip);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: rl.blocked ? "Source IP temporarily blocked" : "Too many connection attempts" }),
      { status: rl.blocked ? 403 : 429, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Auth: only the caller or callee may join the signaling relay ──────────
  const token = extractToken(request, url);
  if (!token) {
    return new Response(JSON.stringify({ error: "The access token is invalid" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const row = await resolveToken(env.DB, token);
  if (!row) {
    return new Response(JSON.stringify({ error: "The access token is invalid" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const raw = await env.KV.get(`call:${callId}`);
  if (!raw) {
    return new Response(JSON.stringify({ error: "Call not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  let session: { callerId: string; calleeId: string; state: string };
  try {
    session = JSON.parse(raw) as { callerId: string; calleeId: string; state: string };
  } catch {
    return new Response(JSON.stringify({ error: "Call not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (session.callerId !== row.actor_id && session.calleeId !== row.actor_id) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (session.state === "ended" || session.state === "rejected") {
    return new Response(JSON.stringify({ error: "Call has ended" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  const doId = env.CALL_SIGNALING.idFromName(callId);
  const stub = env.CALL_SIGNALING.get(doId);
  return stub.fetch("https://call-do/connect", { method: request.method, headers: request.headers }) as Promise<Response>;
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

      // Set updated_at = published explicitly: the table's DEFAULT would store
      // `datetime('now')` (space format) which is never === the ISO `published`,
      // so a brand-new post would be misreported as "edited".
      await env.DB
        .prepare("INSERT INTO objects (id, type, actor_id, content, content_warning, sensitive, visibility, in_reply_to_id, language, url, replies_count, reblogs_count, favourites_count, published, updated_at, is_local, raw) VALUES (?, 'Note', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 1, ?)")
        .bind(note.id, s.actor_id, content, sensitive ? spoilerText : null, sensitive ? 1 : 0, visibility, null, language ?? null, note.url ?? note.id, published, published, JSON.stringify(note))
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

async function executeScheduled(env: Env): Promise<void> {
  // Cloudflare cron triggers keep the phase they had at deploy time: a
  // `* * * * *` cron created at 2:51:53 keeps firing at :53 every minute and
  // never at :00. So align the actual work to the top of the next minute.
  // If the trigger already lands within the first few seconds of the minute
  // (on-time delivery), run immediately instead of adding a pointless ~60s wait.
  const secondsIntoMinute = new Date().getSeconds() + new Date().getMilliseconds() / 1000;
  if (secondsIntoMinute > 5) {
    await new Promise((resolve) => setTimeout(resolve, Math.ceil((60 - secondsIntoMinute) * 1000)));
  }

  // Guard against overlapping cron invocations (slow runs or clock drift): only
  // one patrol runs at a time. The lock expires by itself (55s < 1min).
  const lock = await env.KV.get("cron:lock");
  if (lock) {
    console.warn("[cron] skipping overlapping run");
    return;
  }
  await env.KV.put("cron:lock", "1", { expirationTtl: 60 });

  try {
    try {
      await publishDueScheduled(env);
    } catch (err) {
      console.error("[cron] publishDueScheduled failed", err);
    }

  const actors = await env.DB
    .prepare(
      "SELECT id, auto_delete_after FROM actors WHERE is_local = 1 AND auto_delete_after IS NOT NULL AND auto_delete_after > 0"
    )
    .all<{ id: string; auto_delete_after: number }>();

  for (const actor of actors.results) {
    const cutoff = new Date(Date.now() - actor.auto_delete_after * 1000).toISOString();

    const objects = await env.DB
      .prepare(
        "SELECT id, visibility FROM objects WHERE actor_id = ? AND published < ? AND is_local = 1 AND type = 'Note'"
      )
      .bind(actor.id, cutoff)
      .all<{ id: string; visibility: string }>();

    if (objects.results.length === 0) continue;

    const localActor = await getActorById(env.DB, actor.id);
    if (!localActor) continue;

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
            await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(deleteActivity), localActor.id, `${localActor.id}#main-key`, localActor.privateKeyPem);
          }
        }
      }
    }

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

    const ids = objects.results.map((o) => o.id);

    // Delete dependents + objects in chunked batches (D1 caps batch size).
    // status_pins and custom_filter_statuses have no FK to objects, so they
    // must be removed explicitly; everything else cascades.
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      await env.DB.batch([
        ...chunk.map((id) => env.DB.prepare("DELETE FROM status_pins WHERE status_id = ?").bind(id)),
        ...chunk.map((id) => env.DB.prepare("DELETE FROM custom_filter_statuses WHERE status_id = ?").bind(id)),
        ...chunk.map((id) => env.DB.prepare("DELETE FROM objects WHERE id = ?").bind(id)),
      ]);
    }

    // Keep the profile status counter accurate (matches the manual delete path).
    await env.DB
      .prepare("UPDATE actors SET statuses_count = MAX(COALESCE(statuses_count, 0) - ?, 0) WHERE id = ?")
      .bind(ids.length, actor.id)
      .run();
  }

  // Repair sweep (daily): purge legacy dangling rows left by older deletes.
  // status_pins / custom_filter_statuses reference objects without a FK, so
  // rows whose status no longer exists are dead weight (and pins count against
  // the pin limit). Idempotent; guarded by a KV marker to run once per day.
  try {
    if (!(await env.KV.get("cron:cleanup:dangling"))) {
      await env.DB
        .prepare(
          "DELETE FROM status_pins WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.id = status_pins.status_id)"
        )
        .run();
      await env.DB
        .prepare(
          "DELETE FROM custom_filter_statuses WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.id = custom_filter_statuses.status_id)"
        )
        .run();
      await env.KV.put("cron:cleanup:dangling", "1", { expirationTtl: 86400 });
    }
  } catch (err) {
    console.error("[cron] dangling-cleanup failed", err);
  }

  // AI Guardian patrol — reviews recent posts and suspicious accounts, blocks
  // spam domains. Runs after the routine tasks; each run is idempotent via KV
  // markers so overlapping cron invocations stay cheap.
  try {
    await runModerationCycle(env as unknown as Parameters<typeof runModerationCycle>[0]);
  } catch (err) {
    console.error("[cron] runModerationCycle failed", err);
  }

  // Account verification — periodically re-check rel="me" backlinks so the
  // verified badge stays accurate when an external site changes its markup.
  try {
    await verifyAccountFieldsCron(env);
  } catch (err) {
    console.error("[cron] verifyAccountFieldsCron failed", err);
  }
  } catch (err) {
    console.error("[cron] executeScheduled failed", err);
  } finally {
    await env.KV.delete("cron:lock").catch(() => {});
  }
}

/**
 * Re-run Mastodon-style verification for local and remote accounts that have a
 * link-valued profile field. The external fetch is SSRF-guarded and each field
 * check is cached in actor_fields.verified_at.
 */
async function verifyAccountFieldsCron(env: Env): Promise<void> {
  try {
    // Local accounts — re-check occasionally (30 min via KV marker) so slow sites
// don't stall every cron run. Bounded to a few per run (each check fetches the
// external page) so the whole cron stays inside the 60s overlap window.
// ORDER BY verified_at ASC: failed/never-checked fields (NULL) are retried
// first, then the longest-verified ones get re-checked (badge revocation).
const localRows = await env.DB
      .prepare(
        `SELECT DISTINCT af.actor_id FROM actor_fields af
         JOIN actors a ON a.id = af.actor_id
         WHERE a.is_local = 1 AND (af.value LIKE 'http%' OR af.value LIKE '%href=%')
         ORDER BY af.verified_at ASC
         LIMIT 5`
      )
      .all<{ actor_id: string }>();
    for (const row of localRows.results) {
      const actor = await getActorById(env.DB, row.actor_id);
      if (!actor) continue;
      const marker = `verify:local:${actor.id}`;
      if (await env.KV.get(marker)) continue;
      await verifyAccountFields(env.DB, actor.id, actor.domain);
      await env.KV.put(marker, "1", { expirationTtl: 1800 });
    }

    // Remote accounts — verify those with unverified link fields (or never
    // checked), bounded to a few per run so the cron stays under the memory
    // and time budget (each check fetches an external page).
    const remoteRows = await env.DB
      .prepare(
        `SELECT DISTINCT af.actor_id FROM actor_fields af
         JOIN actors a ON a.id = af.actor_id
         WHERE a.is_local = 0 AND (af.value LIKE 'http%' OR af.value LIKE '%href=%')
           AND NOT EXISTS (
             SELECT 1 FROM actor_fields f2
             WHERE f2.actor_id = af.actor_id AND f2.verified_at IS NOT NULL
           )
         LIMIT 5`
      )
      .all<{ actor_id: string }>();
    for (const row of remoteRows.results) {
      const actor = await getActorById(env.DB, row.actor_id);
      if (!actor) continue;
      await verifyAccountFields(env.DB, actor.id, actor.domain);
    }
  } catch (err) {
    console.error("[cron] verifyAccountFields failed", err);
  }
}

const worker = {
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
    // Deliver in-flight requests concurrently so a batch never takes longer
    // than the consumer visibility timeout (see wrangler.toml). A serial loop
    // of up to 20 inboxes x 15s each could exceed it and trigger spurious
    // redeliveries that exhaust max_retries and drop messages.
    const CONCURRENCY = 10;
    const messages = [...batch.messages];
    let cursor = 0;

    const process = async (): Promise<void> => {
      while (cursor < messages.length) {
        const message = messages[cursor++];
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
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, messages.length) }, () => process())
    );
  },

  // Scheduled handler: auto-delete old statuses for users who have enabled it
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(executeScheduled(env));
  },
};

export default worker;
