// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { canAnalyseSource, getMediaAnalyser, sampleFrequencyLevels } from "@/lib/audio-visualizer";

describe("canAnalyseSource", () => {
  it("accepts same-origin sources (media cache URLs, local uploads)", () => {
    expect(canAnalyseSource("/api/media/cache/media/x.mp3")).toBe(true);
    expect(canAnalyseSource(`${window.location.origin}/api/media/media/user/x.mp3`)).toBe(true);
  });

  it("rejects cross-origin sources so Web Audio never silences them", () => {
    expect(canAnalyseSource("https://remote.example/media/x.mp3")).toBe(false);
  });

  it("rejects empty values", () => {
    expect(canAnalyseSource("")).toBe(false);
  });
});

describe("sampleFrequencyLevels", () => {
  function analyserFor(bytes: Uint8Array): AnalyserNode {
    return {
      frequencyBinCount: bytes.length,
      getByteFrequencyData: (out: Uint8Array) => out.set(bytes),
    } as unknown as AnalyserNode;
  }

  it("maps low-frequency energy to the first bars and leaves the rest dark", () => {
    const bins = 128;
    const bytes = new Uint8Array(bins).fill(0);
    for (let i = 0; i < 8; i++) bytes[i] = 255;
    const levels = new Uint8Array(16);
    sampleFrequencyLevels(analyserFor(bytes), levels, new Uint8Array(bins));
    expect(levels[0]).toBeGreaterThan(200);
    expect(levels[levels.length - 1]).toBe(0);
  });

  it("returns silence for an all-zero spectrum", () => {
    const levels = new Uint8Array(8);
    sampleFrequencyLevels(analyserFor(new Uint8Array(128)), levels, new Uint8Array(128));
    expect(Array.from(levels)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("getMediaAnalyser", () => {
  it("returns null (and caches it) when the browser has no Web Audio", () => {
    const el = document.createElement("audio");
    expect(getMediaAnalyser(el)).toBeNull();
    expect(getMediaAnalyser(el)).toBeNull();
  });
});
