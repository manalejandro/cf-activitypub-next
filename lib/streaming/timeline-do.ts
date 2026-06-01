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
 *   "home:{actorId}"  — home feed for a specific authenticated actor
 *   "hashtag:{tag}"   — public statuses tagged with a given hashtag
 */

import { DurableObject as CFDurableObject } from "cloudflare:workers";

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

    // Tag the hibernated socket with the channel name so we can fan-out by tag
    this.state.acceptWebSocket(server, [channel]);

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

    const sockets = this.state.getWebSockets(channel);
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Socket disconnected; hibernation handles cleanup automatically
      }
    }

    return new Response(null, { status: 204 });
  }

  // ─── WebSocket Hibernation callbacks ──────────────────────────────────────

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Clients may send "ping" to keep proxies from timing out the connection
    if (typeof message === "string" && message.trim() === "ping") {
      ws.send("pong");
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
