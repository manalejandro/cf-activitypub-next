// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  distanceMeters,
  isLocationPageUrl,
  parseCoordinatePair,
  routeApiUrl,
  routeEndsShort,
  routeRequestUrls,
  routeSnapTooFar,
  ROUTE_END_TOLERANCE_METERS,
  locationEmbedUrl,
  locationPageUrl,
  locationPath,
  parseLocationQuery,
  previewCardFor,
  staticLocationTileUrl,
} from "@/lib/location";
import { buildNote, extractLocationJson, parseLocationJson } from "@/lib/activitypub/utils";
import type { APAttachment } from "@/lib/types";

const MADRID = { name: "Puerta del Sol", latitude: 40.4168, longitude: -3.7038 };

describe("location URLs", () => {
  it("builds the public page and embed URLs", () => {
    const page = locationPageUrl("https://cf-ap.com/", MADRID);
    expect(page).toBe("https://cf-ap.com/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol");
    expect(locationEmbedUrl("https://cf-ap.com", MADRID)).toContain("/embed/location?lat=40.416800&lng=-3.703800");
  });

  it("parses and validates query parameters", () => {
    const ok = parseLocationQuery(new URLSearchParams("lat=40,4168&lng=-3.7038&name=Sol"));
    expect(ok).toEqual({ name: "Sol", latitude: 40.4168, longitude: -3.7038 });
    expect(parseLocationQuery(new URLSearchParams("lat=91&lng=0"))).toBeNull();
    expect(parseLocationQuery(new URLSearchParams("lat=0&lng=-181"))).toBeNull();
    expect(parseLocationQuery(new URLSearchParams("lat=abc&lng=0"))).toBeNull();
    expect(parseLocationQuery(new URLSearchParams())).toBeNull();
  });

  it("computes the static tile used as OG image / oEmbed thumbnail", () => {
    expect(staticLocationTileUrl("https://cf-ap.com/", MADRID)).toBe("https://cf-ap.com/api/map/tiles/14/8023/6177.png");
  });
});

describe("location pages and preview cards", () => {
  it("measures great-circle distances for the straight-line fallback", () => {
    const madrid = { name: null, latitude: 40.4168, longitude: -3.7038 };
    const barcelona = { name: null, latitude: 41.3874, longitude: 2.1686 };
    const meters = distanceMeters(madrid, barcelona);
    expect(meters).toBeGreaterThan(490_000);
    expect(meters).toBeLessThan(520_000);
    expect(distanceMeters(madrid, madrid)).toBe(0);
  });

  it("builds the documented OSRM route requests (lon,lat order, geojson)", () => {
    const sevilla = { name: null, latitude: 37.3891, longitude: -5.9845 };
    const sanJose = { name: null, latitude: 9.9281, longitude: -84.0907 };
    // FOSSGIS carries real per-profile datasets; the OSRM demo answers every
    // profile path with its car data, so it is only a driving fallback.
    expect(routeRequestUrls("driving", sevilla, sanJose)).toEqual([
      "https://routing.openstreetmap.de/routed-car/route/v1/driving/-5.9845,37.3891;-84.0907,9.9281?overview=full&geometries=geojson",
      "https://router.project-osrm.org/route/v1/driving/-5.9845,37.3891;-84.0907,9.9281?overview=full&geometries=geojson",
    ]);
    expect(routeRequestUrls("foot", sevilla, sanJose)).toEqual([
      "https://routing.openstreetmap.de/routed-foot/route/v1/foot/-5.9845,37.3891;-84.0907,9.9281?overview=full&geometries=geojson",
    ]);
  });

  it("treats a far snap or a too-short route as not reaching the destination", () => {
    const sevilla = { name: null, latitude: 37.3891, longitude: -5.9845 };
    const sanJose = { name: null, latitude: 9.9281, longitude: -84.0907 };
    const direct = distanceMeters(sevilla, sanJose);
    // Real capture: Spain → Costa Rica ends at Cabo de São Vicente with a
    // waypoint snap distance of 8 237 658 m and a 309 km route.
    expect(direct).toBeGreaterThan(7_000_000);
    expect(routeSnapTooFar(8_237_658, ROUTE_END_TOLERANCE_METERS)).toBe(true);
    expect(routeEndsShort(8_237_658, 309_105, direct)).toBe(true);
    // A normal route: the endpoint snaps within metres and is longer than the
    // direct line.
    expect(routeSnapTooFar(0.67, ROUTE_END_TOLERANCE_METERS)).toBe(false);
    expect(routeSnapTooFar(null, ROUTE_END_TOLERANCE_METERS)).toBe(false);
    expect(routeEndsShort(70, direct * 1.15, direct)).toBe(false);
  });

  it("parses lat,lng query pairs and builds the same-origin routing URL", () => {
    expect(parseCoordinatePair("37.3891,-5.9845")).toEqual({
      name: null,
      latitude: 37.3891,
      longitude: -5.9845,
    });
    expect(parseCoordinatePair("37.3891")).toBeNull();
    expect(parseCoordinatePair("91,0")).toBeNull();
    expect(parseCoordinatePair("0,181")).toBeNull();
    expect(parseCoordinatePair("a,b")).toBeNull();
    expect(parseCoordinatePair(null)).toBeNull();

    const sevilla = { name: null, latitude: 37.38912345, longitude: -5.98456789 };
    const lisboa = { name: null, latitude: 38.7223, longitude: -9.1393 };
    expect(routeApiUrl("foot", sevilla, lisboa)).toBe(
      "/api/route?profile=foot&from=37.38912,-5.98457&to=38.72230,-9.13930"
    );
  });

  it("detects location page URLs on any instance", () => {
    expect(isLocationPageUrl("https://cf-ap.com/locations?lat=37.39&lng=-5.97&name=X")).toBe(true);
    expect(isLocationPageUrl("https://other.example/locations/?lat=1&lng=2")).toBe(true);
    expect(isLocationPageUrl("https://cf-ap.com/locations")).toBe(false);
    expect(isLocationPageUrl("https://cf-ap.com/statuses/1")).toBe(false);
    expect(isLocationPageUrl(null)).toBe(false);
  });

  it("drops the duplicate location card when the status renders the map", () => {
    const card = { url: "https://cf-ap.com/locations?lat=37.39&lng=-5.97&name=X", title: "X" };
    expect(previewCardFor(card, { name: "X", latitude: 37.39, longitude: -5.97 })).toBeNull();
    // Cards for other links stay even when the status has a location.
    const youTube = { url: "https://www.youtube.com/watch?v=abc", title: "Video" };
    expect(previewCardFor(youTube, { name: "X", latitude: 37.39, longitude: -5.97 })).toBe(youTube);
    // No location: the card renders as usual.
    expect(previewCardFor(card, null)).toBe(card);
  });
});

describe("buildNote location federation", () => {
  it("links to our location page and adds the Link attachment Mastodon crawls", () => {
    const note = buildNote("https://cf-ap.com", "abc", {
      actorUsername: "ale",
      content: "<p>Hola</p>",
      published: "2026-09-27T00:00:00.000Z",
      visibility: "public",
      location: MADRID,
    });
    const attachments = (note.attachment ?? []) as unknown as APAttachment[];
    const link = attachments.find((a) => (a as unknown as { type?: string }).type === "Link") as unknown as {
      href: string;
      mediaType: string;
    };
    expect(link?.href).toBe("https://cf-ap.com/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol");
    expect(link?.mediaType).toBe("text/html");
    expect(note.content).toContain('href="https://cf-ap.com/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol"');
  });

  it("federates the page URL in the Place so remote maps link there too", () => {
    const note = buildNote("https://cf-ap.com", "abc", {
      actorUsername: "ale",
      content: "<p>Hola</p>",
      published: "2026-09-27T00:00:00.000Z",
      visibility: "public",
      location: MADRID,
    });
    const place = note.location as unknown as { type: string; url?: string };
    expect(place.type).toBe("Place");
    expect(place.url).toBe("https://cf-ap.com/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol");
  });

  it("keeps a valid page URL on ingest and drops other schemes", () => {
    const place = { type: "Place", name: "X", latitude: 40.4, longitude: -3.7 };
    const stored = extractLocationJson({
      location: { ...place, url: "https://remote.example/locations?lat=40.4&lng=-3.7" },
    });
    expect(JSON.parse(String(stored)).url).toBe("https://remote.example/locations?lat=40.4&lng=-3.7");
    expect(parseLocationJson(stored)?.url).toBe("https://remote.example/locations?lat=40.4&lng=-3.7");

    const unsafe = extractLocationJson({ location: { ...place, url: "javascript:alert(1)" } });
    expect(JSON.parse(String(unsafe)).url).toBeUndefined();
    // Rows stored before the URL was federated serialize without one.
    expect(parseLocationJson(JSON.stringify(place))?.url).toBeNull();
  });

  it("falls back to the viewer's own location page path", () => {
    expect(locationPath(MADRID)).toBe("/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol");
  });

  it("keeps media attachments and appends the location link", () => {
    const media = [{ type: "Document", mediaType: "image/png", url: "https://cf-ap.com/api/media/x.png" }] as unknown as APAttachment[];
    const note = buildNote("https://cf-ap.com", "abc", {
      actorUsername: "ale",
      content: "<p>Hola</p>",
      published: "2026-09-27T00:00:00.000Z",
      visibility: "public",
      attachments: media,
      location: MADRID,
    });
    expect(note.attachment).toHaveLength(2);
  });
});
