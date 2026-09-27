// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: () => ({ env: { INSTANCE_URL: "https://cf-ap.com", INSTANCE_TITLE: "CF AP" } }),
  getBaseUrl: (env: { INSTANCE_URL?: string }) => env.INSTANCE_URL ?? "https://cf-ap.com",
  json: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
}));
vi.mock("@/lib/db", () => ({
  getActorById: vi.fn(),
  getObjectById: vi.fn(),
}));

import { GET } from "@/app/api/oembed/route";

function req(url: string): NextRequest {
  return { url } as unknown as NextRequest;
}

const page = "https://cf-ap.com/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol";
const endpoint = `https://cf-ap.com/api/oembed?url=${encodeURIComponent(page)}`;

describe("oEmbed for location pages", () => {
  it("returns a rich map player with a static thumbnail", async () => {
    const res = await GET(req(endpoint));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("rich");
    expect(body.title).toBe("Puerta del Sol");
    expect(String(body.html)).toContain("/embed/location?lat=40.416800&lng=-3.703800");
    expect(String(body.html)).toContain("<iframe");
    expect(body.thumbnail_url).toBe("https://cf-ap.com/api/map/tiles/14/8023/6177.png");
    expect(body.thumbnail_width).toBe(256);
    expect(body.url).toBe(page);
  });

  it("rejects invalid coordinates and foreign hosts", async () => {
    const bad = `https://cf-ap.com/api/oembed?url=${encodeURIComponent("https://cf-ap.com/locations?lat=999&lng=0")}`;
    expect((await GET(req(bad))).status).toBe(404);

    const foreign = `https://cf-ap.com/api/oembed?url=${encodeURIComponent("https://other.example/locations?lat=1&lng=1")}`;
    expect((await GET(req(foreign))).status).toBe(404);
  });
});
