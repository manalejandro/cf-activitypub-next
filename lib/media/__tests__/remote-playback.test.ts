// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { audioPlaybackUrl, isSameOriginUrl, MEDIA_RELAY_PATH } from "@/lib/media/remote-playback";

const REMOTE = "https://remote.example/media/song.mp3";

describe("isSameOriginUrl", () => {
  it("accepts relative and own-origin URLs", () => {
    expect(isSameOriginUrl("/api/media/media/user/x.mp3")).toBe(true);
    expect(isSameOriginUrl(`${window.location.origin}/api/media/cache/media/x.mp3`)).toBe(true);
  });

  it("rejects other origins, empty values and non-http(s) sources", () => {
    expect(isSameOriginUrl(REMOTE)).toBe(false);
    expect(isSameOriginUrl("")).toBe(false);
    expect(isSameOriginUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("audioPlaybackUrl", () => {
  it("leaves same-origin audio (local uploads, the cache) untouched", () => {
    expect(audioPlaybackUrl("/api/media/media/user/x.mp3")).toBe("/api/media/media/user/x.mp3");
    expect(audioPlaybackUrl(`${window.location.origin}/api/media/cache/media/x.mp3`)).toBe(
      `${window.location.origin}/api/media/cache/media/x.mp3`
    );
  });

  it("relays a cross-origin attachment so Web Audio can analyse it", () => {
    expect(audioPlaybackUrl(REMOTE)).toBe(`${MEDIA_RELAY_PATH}?url=${encodeURIComponent(REMOTE)}`);
  });

  it("never relays sources the relay cannot serve", () => {
    expect(audioPlaybackUrl("")).toBe("");
    expect(audioPlaybackUrl("data:audio/mpeg;base64,AAAA")).toBe("data:audio/mpeg;base64,AAAA");
    expect(audioPlaybackUrl("blob:https://cf-ap.com/1234")).toBe("blob:https://cf-ap.com/1234");
  });
});
