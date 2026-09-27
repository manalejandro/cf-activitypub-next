// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: () => ({
    env: { INSTANCE_URL: "https://cf-ap.com", INSTANCE_TITLE: "CF AP", INSTANCE_VERSION: "1.3.4" },
  }),
  getBaseUrl: (env: { INSTANCE_URL?: string }) => env.INSTANCE_URL ?? "https://cf-ap.com",
  json: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
}));
vi.mock("@/lib/activitypub/federation", () => ({
  safeFetch,
}));

import { GET } from "@/app/api/route/route";

const OSRM_OK = {
  code: "Ok",
  routes: [
    {
      distance: 463145.6,
      duration: 18176,
      geometry: { coordinates: [[-5.984502, 37.3891], [-9.139301, 38.722306]] },
    },
  ],
  waypoints: [{ distance: 0.17 }, { distance: 0.67 }],
};

function req(query: string): NextRequest {
  return { url: `https://cf-ap.com/api/route?${query}` } as unknown as NextRequest;
}

const cache = {
  match: vi.fn(async () => null as Response | null),
  put: vi.fn(async () => {}),
};

beforeEach(() => {
  safeFetch.mockReset();
  cache.match.mockReset();
  cache.put.mockReset();
  cache.match.mockResolvedValue(null);
  vi.stubGlobal("caches", { default: cache });
});

describe("routing proxy", () => {
  it("asks the FOSSGIS OSRM server with lon,lat order and passes the route through", async () => {
    safeFetch.mockResolvedValue(new Response(JSON.stringify(OSRM_OK), { status: 200 }));
    const res = await GET(req("profile=driving&from=37.3891,-5.9845&to=38.7223,-9.1393"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
    expect(await res.json()).toMatchObject({ code: "Ok" });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://routing.openstreetmap.de/routed-car/route/v1/driving/-5.9845,37.3891;-9.1393,38.7223?overview=full&geometries=geojson"
    );
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(
      "CFActivityPub/1.3.4 (+https://cf-ap.com; routing)"
    );
    // Successful routes are cached (rounded coordinates) for the next visitor.
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("routes walking through the foot dataset", async () => {
    safeFetch.mockResolvedValue(new Response(JSON.stringify(OSRM_OK), { status: 200 }));
    await GET(req("profile=foot&from=40.4168,-3.7038&to=40.4200,-3.6955"));
    const [url] = safeFetch.mock.calls[0] as [string];
    expect(url).toContain("https://routing.openstreetmap.de/routed-foot/route/v1/foot/");
  });

  it("serves a cached route without hitting the routing server", async () => {
    cache.match.mockResolvedValue(
      new Response(JSON.stringify(OSRM_OK), { status: 200, headers: { "content-type": "application/json" } })
    );
    const res = await GET(req("profile=driving&from=37.3891,-5.9845&to=38.7223,-9.1393"));
    expect(res.status).toBe(200);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed coordinates", async () => {
    expect((await GET(req("from=37.3891,-5.9845"))).status).toBe(400);
    expect((await GET(req("from=999,-5.9845&to=38.72,-9.13"))).status).toBe(400);
    expect((await GET(req("from=37.3891&to=38.72,-9.13"))).status).toBe(400);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reports 502 when the routing servers fail or find no route", async () => {
    safeFetch.mockResolvedValue(null);
    expect((await GET(req("from=37.3891,-5.9845&to=38.7223,-9.1393"))).status).toBe(502);

    safeFetch.mockReset();
    safeFetch.mockResolvedValue(
      new Response(JSON.stringify({ code: "NoRoute" }), { status: 400 })
    );
    expect((await GET(req("from=37.3891,-5.9845&to=38.7223,-9.1393"))).status).toBe(502);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
