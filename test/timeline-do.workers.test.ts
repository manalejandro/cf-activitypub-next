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

describe("TimelineStreamDO anonymous subscribe gating", () => {
  function connectWith(query: string): Promise<WebSocket> {
    const stub = env.TIMELINE_STREAM.get(env.TIMELINE_STREAM.idFromName("timeline"));
    return stub
      .fetch(`https://do/connect?${query}`, { headers: { Upgrade: "websocket" } })
      .then((res) => {
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        expect(ws).toBeTruthy();
        ws!.accept();
        return ws!;
      });
  }

  function closeAndWait(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }

  async function broadcast(channel: string): Promise<void> {
    const stub = env.TIMELINE_STREAM.get(env.TIMELINE_STREAM.idFromName("timeline"));
    const res = await stub.fetch("https://do/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, event: "update", payload: '{"id":"s1"}' }),
    });
    expect(res.status).toBe(204);
  }

  it("refuses a subscribe beyond the socket's anonymous access level", async () => {
    const ws = await connectWith("channel=public&anon=public");
    const message = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe", stream: "public:local" }));
    const received = JSON.parse(await message) as { status?: number };
    expect(received.status).toBe(401);
    await closeAndWait(ws);
  });

  it("refuses a hashtag subscribe on an anonymous socket (session-only)", async () => {
    const ws = await connectWith("channel=public&anon=public_local");
    const message = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    ws.send(JSON.stringify({ type: "subscribe", stream: "hashtag", tag: "cats" }));
    const received = JSON.parse(await message) as { status?: number };
    expect(received.status).toBe(401);
    await closeAndWait(ws);
  });

  it("accepts a subscribe inside the level and delivers its broadcasts", async () => {
    const ws = await connectWith("channel=public&anon=public_local");
    ws.send(JSON.stringify({ type: "subscribe", stream: "public:local" }));
    const received = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    // Let the subscribe message be processed before the broadcast arrives.
    await new Promise((r) => setTimeout(r, 100));
    await broadcast("public:local");
    await expect(received).resolves.toContain('"event":"update"');
    await closeAndWait(ws);
  });

  it("does not gate an authenticated socket", async () => {
    const ws = await connectWith(`channel=${encodeURIComponent("home:alice")}&authed=1`);
    ws.send(JSON.stringify({ type: "subscribe", stream: "public:local" }));
    const received = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    await new Promise((r) => setTimeout(r, 100));
    await broadcast("public:local");
    await expect(received).resolves.toContain('"event":"update"');
    await closeAndWait(ws);
  });
});
