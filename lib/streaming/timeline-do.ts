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
 */

import { DurableObject as CFDurableObject } from "cloudflare:workers";

/** Map a Mastodon stream name + optional tag to an internal channel name. */
function resolveStreamToChannel(stream: string, tag?: string | null): string | null {
  switch (stream) {
    case "public":        return "public";
    case "public:local":  return "public:local";
    case "hashtag":       return tag ? `hashtag:${tag.toLowerCase()}` : null;
    case "hashtag:local": return tag ? `hashtag:local:${tag.toLowerCase()}` : null;
    default:              return null;
  }
}

type SocketAttachment = { channels?: string[] };

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

  private handleConnect(request: Request, url: URL): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const channel = url.searchParams.get("channel") ?? "public";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Tag the hibernated socket with the channel name so we can fan-out by tag.
    // Also store the initial channel in the attachment for dynamic subscription tracking.
    this.state.acceptWebSocket(server, [channel]);
    server.serializeAttachment({ channels: [] } satisfies SocketAttachment);

    return new Response(null, { status: 101, webSocket: client });
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
      const msg = JSON.parse(text) as { type?: string; stream?: string; tag?: string };
      if (!msg.type || !msg.stream) return;

      const channel = resolveStreamToChannel(msg.stream, msg.tag);
      if (!channel) return;

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

  webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.error("[TimelineStreamDO] WebSocket error:", error);
    ws.close();
  }
}
