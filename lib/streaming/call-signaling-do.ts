/**
 * CallSignalingDO — Cloudflare Durable Object for WebRTC call signaling relay.
 *
 * One instance per active call (keyed by call UUID).  Both the caller and the
 * callee connect via WebSocket.  Every message sent by one peer is forwarded
 * verbatim to the other, enabling SDP offer/answer and ICE-candidate exchange
 * without any server-side parsing.
 *
 * REST endpoint:
 *   POST /relay   — inject a pre-serialised signal message from the
 *                   ActivityPub inbox handler (cross-instance ICE delivery).
 */

import { DurableObject as CFDurableObject } from "cloudflare:workers";

export class CallSignalingDO extends CFDurableObject {
  readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: never) {
    super(state, env);
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleConnect();
    }

    if (url.pathname.endsWith("/relay") && request.method === "POST") {
      return this.handleRelay(request);
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket upgrade ────────────────────────────────────────────────────

  private handleConnect(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server, ["peer"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── REST relay (cross-instance ICE forwarding) ───────────────────────────

  private async handleRelay(request: Request): Promise<Response> {
    const body = await request.text();
    for (const ws of this.state.getWebSockets("peer")) {
      try { ws.send(body); } catch { /* socket closed — ignore */ }
    }
    return new Response(null, { status: 204 });
  }

  // ─── WebSocket Hibernation callbacks ──────────────────────────────────────

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message.trim() === "ping") {
      ws.send("pong");
      return;
    }
    // Relay to all OTHER connected peers
    for (const other of this.state.getWebSockets("peer")) {
      if (other === ws) continue;
      try { other.send(message as string); } catch { /* ignore */ }
    }
  }

  webSocketClose(ws: WebSocket): void {
    const hangup = JSON.stringify({ type: "hangup", reason: "peer_disconnected" });
    for (const other of this.state.getWebSockets("peer")) {
      if (other === ws) continue;
      try { other.send(hangup); } catch { /* ignore */ }
    }
    ws.close();
  }
}
