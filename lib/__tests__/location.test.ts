// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  locationEmbedUrl,
  locationPageUrl,
  parseLocationQuery,
  staticLocationTileUrl,
} from "@/lib/location";
import { buildNote } from "@/lib/activitypub/utils";
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
