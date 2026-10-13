import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * The streaming Durable Object uses the WebSocket Hibernation API: sockets are
 * accepted with `state.acceptWebSocket()`, per-socket state lives in the
 * attachment (it survives hibernation) and the keep-alive "ping" is answered by
 * `setWebSocketAutoResponse` so it never wakes the object.
 */
describe("TimelineStreamDO", () => {
  function connect(): Promise<WebSocket> {
    const stub = env.TIMELINE_STREAM.get(env.TIMELINE_STREAM.idFromName("timeline"));
    return stub
      .fetch("https://do/connect?channel=public", { headers: { Upgrade: "websocket" } })
      .then((res) => {
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        expect(ws).toBeTruthy();
        ws!.accept();
        return ws!;
      });
  }

  it("answers a keep-alive ping without the app handler", async () => {
    const ws = await connect();
    const pong = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    ws.send("ping");
    await expect(pong).resolves.toBe("pong");
    ws.close();
  });

  it("broadcasts to sockets tagged with the channel", async () => {
    const ws = await connect();
    const received = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });

    const stub = env.TIMELINE_STREAM.get(env.TIMELINE_STREAM.idFromName("timeline"));
    const res = await stub.fetch("https://do/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "public", event: "update", payload: '{"id":"s1"}' }),
    });
    expect(res.status).toBe(204);

    await expect(received).resolves.toContain('"event":"update"');
    ws.close();
  });

  it("rejects a connection without the upgrade header", async () => {
    const stub = env.TIMELINE_STREAM.get(env.TIMELINE_STREAM.idFromName("timeline"));
    const res = await stub.fetch("https://do/connect?channel=public");
    expect(res.status).toBe(426);
  });
});
