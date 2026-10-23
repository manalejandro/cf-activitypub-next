import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

const federation = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/activitypub/federation", () => federation);

import { GET } from "@/app/api/media/remote/route";

const BASE = "https://cf-ap.com";
const REMOTE = "https://remote.example/media/song.mp3";
const OBJECT = "https://remote.example/objects/1";

const relay = (url: string, headers: Record<string, string> = {}) =>
  GET(new NextRequest(`${BASE}/api/media/remote?url=${encodeURIComponent(url)}`, { headers }));

function upstream(status: number, headers: Record<string, string> = {}, body = "audio-bytes"): Response {
  return new Response(body, { status, headers });
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  federation.safeFetch.mockReset();
  await env.DB
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, 'ana', 'remote.example', 'k', 0)")
    .bind("https://remote.example/users/ana")
    .run();
  await env.DB
    .prepare(
      `INSERT INTO objects (id, actor_id, content, url, published, raw)
       VALUES (?, ?, '<p>hola</p>', ?, '2026-10-22T10:00:00.000Z', '{}')`
    )
    .bind(OBJECT, "https://remote.example/users/ana", OBJECT)
    .run();
  await env.DB
    .prepare(
      `INSERT INTO attachments (id, object_id, type, url, remote_url, mime_type)
       VALUES ('a1', ?, 'audio', ?, ?, 'audio/mpeg')`
    )
    .bind(OBJECT, REMOTE, REMOTE)
    .run();
});

describe("GET /api/media/remote", () => {
  it("streams a stored audio attachment through our own origin, range included", async () => {
    federation.safeFetch.mockResolvedValue(
      upstream(206, {
        "content-type": "audio/mpeg",
        "content-length": "11",
        "content-range": "bytes 0-10/100",
        "accept-ranges": "bytes",
      })
    );

    const res = await relay(REMOTE, { range: "bytes=0-10" });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-range")).toBe("bytes 0-10/100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("private, max-age=600");
    expect(await res.text()).toBe("audio-bytes");

    const [url, init, timeout] = federation.safeFetch.mock.calls[0] as [string, { headers: HeadersInit }, number];
    expect(url).toBe(REMOTE);
    expect(new Headers(init.headers).get("range")).toBe("bytes=0-10");
    // A long episode must not be aborted by the 10 s outbound guard.
    expect(timeout).toBe(0);
  });

  it("does not relay URLs that are not stored audio attachments", async () => {
    const unknown = await relay("https://elsewhere.example/audio.mp3");
    expect(unknown.status).toBe(404);
    expect(federation.safeFetch).not.toHaveBeenCalled();
  });

  it("matches what the serializer sends: audio by type or by mime", async () => {
    federation.safeFetch.mockResolvedValue(upstream(200, { "content-type": "audio/mpeg" }));

    // A peer may omit the AP type; `serializeAttachment` falls back to the mime.
    await env.DB.prepare("UPDATE attachments SET type = 'unknown' WHERE id = 'a1'").run();
    expect((await relay(REMOTE)).status).toBe(200);

    federation.safeFetch.mockClear();
    await env.DB.prepare("UPDATE attachments SET type = 'video', mime_type = 'video/mp4' WHERE id = 'a1'").run();
    expect((await relay(REMOTE)).status).toBe(404);
    expect(federation.safeFetch).not.toHaveBeenCalled();
  });

  it("rejects missing and non-https URLs", async () => {
    expect((await GET(new NextRequest(`${BASE}/api/media/remote`))).status).toBe(400);
    expect((await relay("http://remote.example/media/song.mp3")).status).toBe(400);
    expect(federation.safeFetch).not.toHaveBeenCalled();
  });

  it("answers 502 when the origin cannot be reached", async () => {
    federation.safeFetch.mockResolvedValue(null);
    const res = await relay(REMOTE);
    expect(res.status).toBe(502);
  });
});
