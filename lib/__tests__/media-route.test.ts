// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const meta = {
  size: 100,
  httpEtag: '"etag-1"',
  writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "video/mp4"),
};

const r2 = {
  head: vi.fn(),
  get: vi.fn(),
};

vi.mock("@/lib/cf", () => ({ getCloudflareContext: () => ({ env: { R2: r2 } }) }));

import { GET, HEAD } from "@/app/api/media/[...key]/route";

function req(init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  return {
    method: init.method ?? "GET",
    headers: new Headers(init.headers ?? {}),
    nextUrl: new URL("https://local.example/api/media/cache/media/clip.mp4"),
    url: "https://local.example/api/media/cache/media/clip.mp4",
  } as unknown as NextRequest;
}

const context = { params: Promise.resolve({ key: ["cache", "media", "clip.mp4"] }) };

beforeEach(() => {
  r2.head.mockReset();
  r2.get.mockReset();
  r2.head.mockResolvedValue(meta);
  r2.get.mockImplementation(async (_key: string, options?: { range?: { offset: number; length: number } }) => {
    const length = options?.range?.length ?? meta.size;
    return {
      ...meta,
      size: meta.size,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(length));
          controller.close();
        },
      }),
    };
  });
});

describe("media route byte ranges", () => {
  it("answers HEAD from metadata without reading the body", async () => {
    const res = await HEAD(req({ method: "HEAD" }), context);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("100");
    expect(r2.get).not.toHaveBeenCalled();
  });

  it("serves a byte range as 206 with Content-Range", async () => {
    const res = await GET(req({ headers: { range: "bytes=10-19" } }), context);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("content-length")).toBe("10");
    expect(r2.get).toHaveBeenCalledWith("cache/media/clip.mp4", { range: { offset: 10, length: 10 } });
  });

  it("supports open-ended and suffix ranges", async () => {
    const open = await GET(req({ headers: { range: "bytes=90-" } }), context);
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 90-99/100");
    expect(open.headers.get("content-length")).toBe("10");

    const suffix = await GET(req({ headers: { range: "bytes=-15" } }), context);
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 85-99/100");
  });

  it("rejects a range beyond the object with 416", async () => {
    const res = await GET(req({ headers: { range: "bytes=200-300" } }), context);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */100");
    expect(r2.get).not.toHaveBeenCalled();
  });

  it("answers 304 when the ETag matches", async () => {
    const res = await GET(req({ headers: { "if-none-match": '"etag-1"' } }), context);
    expect(res.status).toBe(304);
    expect(r2.get).not.toHaveBeenCalled();
  });

  it("streams the whole object with a known length when no range is asked", async () => {
    const res = await GET(req(), context);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(r2.get).toHaveBeenCalledWith("cache/media/clip.mp4");
  });
});
