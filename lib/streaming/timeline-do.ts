/**
 * TimelineStreamDO — Cloudflare Durable Object for real-time ActivityPub
 * timeline streaming using the WebSocket Hibernation API.
 *
 * A single instance is created per zone (name = "timeline").  WebSocket
 * clients connect through the Worker fetch handler, which upgrades the
 * connection and forwards it here.
 *
 * Channels:
 *   "public"          — all public statuses (federated / global timeline)
 *   "public:local"    — public statuses from local actors only
 *   "home:{username}" — home feed for a specific authenticated actor
 *   "hashtag:{tag}"   — public statuses tagged with a given hashtag
 *
 * WebSocket clients may send JSON messages to subscribe/unsubscribe from
 * additional channels after the initial connection:
 *   { "type": "subscribe",   "stream": "public" }
 *   { "type": "unsubscribe", "stream": "hashtag", "tag": "cats" }
 *
 * Abuse protection (connection caps per client IP, tracked durably so they
 * survive isolate eviction; enforced right after the WebSocket handshake so
 * storage I/O never delays the upgrade response):
 *   - Anonymous connections (public / hashtag streams) are capped at 1 socket
 *     per IP and are force-closed after ANON_SOCKET_TTL_MS via a storage alarm,
 *     so nobody can keep an unauthenticated socket reading the instance forever.
 *   - Authenticated connections (home / notification / direct / list) are
 *     capped at AUTH_MAX_CONNS_PER_IP per IP.
 */

import { DurableObject as CFDurableObject } from "cloudflare:workers";

const ANON_MAX_CONNS_PER_IP = 1;
const AUTH_MAX_CONNS_PER_IP = 20;
/** Anonymous public streams are time-boxed to this session length. */
const ANON_SOCKET_TTL_MS = 5 * 60 * 1000;
/** How long a stale connection record may linger before being cleaned up. */
const ANON_RECORD_MAX_AGE_MS = ANON_SOCKET_TTL_MS + 60_000;
const AUTH_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Map a Mastodon stream name + optional tag/list to an internal channel name. */
function resolveStreamToChannel(stream: string, tag?: string | null, listId?: string | null): string | null {
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
    case "hashtag":
      return tag ? `hashtag:${tag.toLowerCase()}` : null;
    case "hashtag:local":
      return tag ? `hashtag:local:${tag.toLowerCase()}` : null;
    case "list":
      return listId ? `list:${listId}` : null;
    // user, user:notification, direct are server-resolved before connecting;
    // clients may also subscribe to them dynamically via subscribe message.
    // We accept them but can only serve if the initial connection was already authenticated.
    case "user":
    case "user:notification":
    case "direct":
      return null; // can't resolve without user context here
    default:
      return null;
  }
}

type SocketAttachment = {
  channels?: string[];
  initialChannel?: string;
  ip?: string;
  socketId?: string;
  anon?: boolean;
  anonCreatedAt?: number;
};

export class TimelineStreamDO extends CFDurableObject {
  readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: never) {
    super(state, env);
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleConnect(request, url);
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      return this.handleBroadcast(request);
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket upgrade ────────────────────────────────────────────────────

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const channel = url.searchParams.get("channel") ?? "public";
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    // Public/hashtag streams are anonymous unless the worker resolved a valid
    // token (logged-in users viewing the public timeline) and flagged the
    // connection as authenticated.
    const authed = url.searchParams.get("authed") === "1";
    const isAnon = !authed && (channel.startsWith("public") || channel.startsWith("hashtag"));
    // IPs are encodeURIComponent'd so the ":"-separated key stays parseable
    // even for IPv6 addresses.
    const ipKey = encodeURIComponent(ip);

    // Accept the WebSocket synchronously — the 101 upgrade handshake must
    // never be delayed by storage I/O. Per-IP abuse caps are enforced
    // immediately afterwards in an async block (see enforceConnectionCap),
    // which prunes stale records and closes the socket if the cap is exceeded.
    const socketId = crypto.randomUUID();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Tag the hibernated socket with the channel name so we can fan-out by tag.
    // Also store the initial channel in the attachment for dynamic subscription tracking.
    this.state.acceptWebSocket(server, [channel]);
    server.serializeAttachment({
      channels: [],
      initialChannel: channel,
      ip,
      socketId,
      ...(isAnon ? { anon: true, anonCreatedAt: Date.now() } : {}),
    } satisfies SocketAttachment);

    // Post-handshake cap enforcement. Runs asynchronously so the upgrade
    // response is not blocked; count is durably recorded so it survives
    // isolate eviction.
    this.state.blockConcurrencyWhile(async () => {
      try {
        const allowed = await this.enforceConnectionCap(ipKey, socketId, isAnon);
        if (!allowed) {
          try { server.close(1013, "too many concurrent connections"); } catch { /* already closed */ }
          return;
        }

        // Time-box anonymous public streams so an unauthenticated socket cannot
        // idle forever and read the instance without limit. The DO exposes one
        // alarm slot, so schedule the *earliest* of this socket's expiry and any
        // already-pending expiry — never blindly overwrite, which would extend
        // earlier sockets' lives (alarm() re-arms to the nearest remaining expiry
        // once it fires). Best-effort: a failed alarm write is not fatal.
        if (isAnon) {
          const expiry = Date.now() + ANON_SOCKET_TTL_MS;
          const existing = await this.state.storage.getAlarm();
          const existingMs = existing == null ? Infinity : Number(existing);
          if (expiry < existingMs) {
            await this.state.storage.setAlarm(expiry).catch(() => {});
          }
        }
      } catch (err) {
        console.error("[TimelineStreamDO] connection cap enforcement failed:", err);
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Durable per-IP connection cap. Counts live in durable storage so they
   * survive isolate eviction. Each record is reconciled against the live
   * WebSocket attachments held by this Durable Object: records whose socket
   * is no longer open (leftover from unclean closes, older versions that never
   * cleaned up, or isolate eviction races) are pruned instead of counting
   * against the cap. Returns false when the socket exceeds the cap for its kind.
   */
  private async enforceConnectionCap(
    ipKey: string,
    socketId: string,
    isAnon: boolean
  ): Promise<boolean> {
    const prefix = `stream_conn:${ipKey}:`;

    // Live sockets for this IP, keyed by attachment socketId. The socket being
    // accepted right now is already registered via acceptWebSocket(), so it is
    // included below. getWebSockets() reflects the full set of open sockets for
    // this Durable Object, including restored (hibernated) ones.
    const live = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      const att = (ws.deserializeAttachment() ?? {}) as SocketAttachment;
      if (att.ip && encodeURIComponent(att.ip) === ipKey && att.socketId) {
        live.add(att.socketId);
      }
    }

    const activeKeys = await this.state.storage.list<{ k: "anon" | "auth"; c: number }>({
      prefix,
      limit: 500,
    });

    let active = 0;
    const stale: string[] = [];
    for (const [key, value] of activeKeys) {
      const rec = value ?? { k: "auth", c: 0 };
      const id = key.slice(prefix.length);
      const maxAgeMs = rec.k === "anon" ? ANON_RECORD_MAX_AGE_MS : AUTH_RECORD_MAX_AGE_MS;
      // Prune records that are too old or no longer correspond to a live socket.
      if (Date.now() - rec.c > maxAgeMs || !live.has(id)) {
        stale.push(key);
        continue;
      }
      active++;
    }

    if (stale.length > 0) {
      await this.state.storage.delete(stale);
    }

    const maxConns = isAnon ? ANON_MAX_CONNS_PER_IP : AUTH_MAX_CONNS_PER_IP;
    if (active >= maxConns) {
      if (!isAnon) return false;
      // Anonymous cap is 1 per IP. A second anonymous socket from the same IP
      // is almost always this browser reconnecting or switching timelines (the
      // local/federated tabs) while the previous socket's close event has not
      // propagated to the DO yet. Rejecting would silently kill the live
      // stream, so instead close the superseded socket and take its slot.
      for (const ws of this.state.getWebSockets()) {
        const att = (ws.deserializeAttachment() ?? {}) as SocketAttachment;
        if (att.ip && encodeURIComponent(att.ip) === ipKey && att.anon && att.socketId !== socketId) {
          try { ws.close(1000, "superseded by a new connection"); } catch { /* already closed */ }
          await this.state.storage.delete(`${prefix}${att.socketId}`).catch(() => {});
        }
      }
    }

    await this.state.storage.put(`${prefix}${socketId}`, {
      k: isAnon ? "anon" : "auth",
      c: Date.now(),
    });
    return true;
  }

  // ─── Broadcast endpoint ───────────────────────────────────────────────────

  private async handleBroadcast(request: Request): Promise<Response> {
    let body: { channel: string; event: string; payload: string };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const { channel, event, payload } = body;
    if (!channel || !event) {
      return new Response("Missing channel or event", { status: 400 });
    }

    // Mastodon streaming wire format
    const message = JSON.stringify({ stream: [channel], event, payload });

    // 1. Send to sockets whose initial channel tag matches
    const taggedSockets = new Set(this.state.getWebSockets(channel));
    for (const ws of taggedSockets) {
      try { ws.send(message); } catch { /* disconnected — hibernation handles cleanup */ }
    }

    // 2. Also send to sockets that subscribed to this channel dynamically
    //    via a subscribe message after the initial connection.
    for (const ws of this.state.getWebSockets()) {
      if (taggedSockets.has(ws)) continue; // already sent above
      const attachment = (ws.deserializeAttachment() ?? {}) as SocketAttachment;
      if (attachment.channels?.includes(channel)) {
        try { ws.send(message); } catch { /* disconnected */ }
      }
    }

    return new Response(null, { status: 204 });
  }

  // ─── WebSocket Hibernation callbacks ──────────────────────────────────────

  /**
   * Storage alarm — wakes the hibernated DO to force-close anonymous public
   * stream sockets that have reached ANON_SOCKET_TTL_MS, then reschedules for
   * the nearest remaining expiry (if any anonymous sockets are still open).
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let nextExpiry = Infinity;

    for (const ws of this.state.getWebSockets()) {
      const att = (ws.deserializeAttachment() ?? {}) as SocketAttachment;
      if (att.anon && att.anonCreatedAt != null) {
        const age = now - att.anonCreatedAt;
        if (age >= ANON_SOCKET_TTL_MS) {
          try { ws.close(1000, "public stream session expired"); } catch { /* already closed */ }
        } else {
          nextExpiry = Math.min(nextExpiry, att.anonCreatedAt + ANON_SOCKET_TTL_MS);
        }
      }
    }

    if (nextExpiry !== Infinity) {
      await this.state.storage.setAlarm(nextExpiry);
    }
  }

  /** Release this socket's per-IP connection slot. */
  private async removeConnection(ws: WebSocket): Promise<void> {
    const att = (ws.deserializeAttachment() ?? {}) as SocketAttachment;
    if (att.ip && att.socketId) {
      await this.state.storage.delete(`stream_conn:${encodeURIComponent(att.ip)}:${att.socketId}`);
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    const text = message.trim();

    // Keep-alive ping
    if (text === "ping") {
      ws.send("pong");
      return;
    }

    // Mastodon subscribe / unsubscribe messages
    try {
      const msg = JSON.parse(text) as { type?: string; stream?: string; tag?: string; list?: string };
      if (!msg.type || !msg.stream) return;

      let channel = resolveStreamToChannel(msg.stream, msg.tag, msg.list);
      if (!channel) {
        // Authenticated streams (user, user:notification, direct) are resolved by
        // the worker before connecting. If the client subscribes to one dynamically,
        // fall back to the initial channel the socket was tagged with.
        const authStreams = ["user", "user:notification", "direct"];
        if (authStreams.includes(msg.stream)) {
          const attachment = (ws.deserializeAttachment() ?? {}) as SocketAttachment;
          channel = attachment.initialChannel ?? null;
        }
      }
      if (!channel) {
        // Per Mastodon spec: send error JSON over the socket for unknown streams
        ws.send(JSON.stringify({ error: "Unknown stream type", status: 400 }));
        return;
      }

      const attachment = ((ws.deserializeAttachment() ?? {}) as SocketAttachment);
      const channels = new Set(attachment.channels ?? []);

      if (msg.type === "subscribe") {
        channels.add(channel);
        ws.serializeAttachment({ channels: Array.from(channels) } satisfies SocketAttachment);
      } else if (msg.type === "unsubscribe") {
        channels.delete(channel);
        ws.serializeAttachment({ channels: Array.from(channels) } satisfies SocketAttachment);
      }
    } catch {
      // Not valid JSON — ignore silently
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.removeConnection(ws);
    ws.close();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[TimelineStreamDO] WebSocket error:", error);
    await this.removeConnection(ws);
    ws.close();
  }
}
