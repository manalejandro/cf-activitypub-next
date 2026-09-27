// @vitest-environment node
import { describe, it, expect } from "vitest";
import { extractAPMeta } from "@/lib/mastodon/serializers";
import type { LocalObject } from "@/lib/types";

function obj(raw: Record<string, unknown>, url: string): LocalObject {
  return { raw: JSON.stringify(raw), url } as unknown as LocalObject;
}

describe("extractAPMeta embedUrl", () => {
  it("reads PeerTube's embedUrl from the raw object", () => {
    const meta = extractAPMeta(obj(
      { type: "Video", embedUrl: "https://koreus.tv/videos/embed/rFRftaZKLEiocZp3wiVLDQ" },
      "https://koreus.tv/w/rFRftaZKLEiocZp3wiVLDQ"
    ));
    expect(meta?.embedUrl).toBe("https://koreus.tv/videos/embed/rFRftaZKLEiocZp3wiVLDQ");
  });

  it("derives the embed player from a PeerTube watch URL", () => {
    const meta = extractAPMeta(obj(
      { type: "Video" },
      "https://peertube.example/videos/watch/d004d318-0e36-4158-ae3b-46e229aa70da"
    ));
    expect(meta?.embedUrl).toBe("https://peertube.example/videos/embed/d004d318-0e36-4158-ae3b-46e229aa70da");
  });

  it("never exposes a non-HTTPS embed (it would be framed)", () => {
    const meta = extractAPMeta(obj(
      { type: "Video", embedUrl: "http://koreus.tv/videos/embed/x" },
      "https://koreus.tv/videos/watch/x"
    ));
    expect(meta?.embedUrl).toBe("https://koreus.tv/videos/embed/x");
  });
});
