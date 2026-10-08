import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MediaPlayer } from "@/components/MediaPlayer";
import {
  mediaPreference,
  resetMediaPreferenceCache,
  setMediaPreference,
  subscribeMediaPreference,
} from "@/lib/media/player-preferences";

beforeEach(() => {
  localStorage.clear();
  resetMediaPreferenceCache();
});

describe("media player audio preference", () => {
  it("defaults to unmuted and remembers changes", () => {
    expect(mediaPreference()).toEqual({ muted: false, volume: 1 });

    const listener = vi.fn();
    const unsubscribe = subscribeMediaPreference(listener);
    setMediaPreference({ muted: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mediaPreference().muted).toBe(true);
    expect(localStorage.getItem("cf-ap:media-muted")).toBe("1");

    setMediaPreference({ volume: 0.25 });
    expect(mediaPreference().volume).toBe(0.25);
    expect(localStorage.getItem("cf-ap:media-volume")).toBe("0.25");
    setMediaPreference({ volume: 2 });
    expect(mediaPreference().volume).toBe(1);
    unsubscribe();
  });

  it("restores the stored preference", () => {
    localStorage.setItem("cf-ap:media-muted", "1");
    localStorage.setItem("cf-ap:media-volume", "0.25");
    resetMediaPreferenceCache();
    expect(mediaPreference()).toEqual({ muted: true, volume: 0.25 });
  });

  it("mutes every player on the page and never unmutes GIFVs", () => {
    act(() => setMediaPreference({ muted: true }));
    const inline = render(<MediaPlayer src="/a.mp4" />);
    // GIFVs render with `muted` like StatusCard does: they must stay silent.
    const gifv = render(<MediaPlayer src="/b.mp4" kind="gifv" autoPlay loop muted />);
    expect(inline.container.querySelector("video")?.muted).toBe(true);
    expect(gifv.container.querySelector("video")?.muted).toBe(true);

    // Unmuting anywhere (e.g. the enlarged viewer) reaches the other players.
    act(() => setMediaPreference({ muted: false }));
    expect(inline.container.querySelector("video")?.muted).toBe(false);
    expect(gifv.container.querySelector("video")?.muted).toBe(true);
  });
});

describe("media player duration", () => {
  it("probes an infinite duration once so the total time can resolve", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration");
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get: () => Number.POSITIVE_INFINITY,
    });
    try {
      const { container } = render(<MediaPlayer src="/a.mp4" />);
      const video = container.querySelector("video") as HTMLVideoElement;
      await waitFor(() => expect(video.currentTime).toBe(Number.MAX_SAFE_INTEGER));
      // A second event must not probe again (it would fight the user's seeks).
      act(() => {
        video.dispatchEvent(new Event("durationchange"));
      });
      expect(video.currentTime).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      if (original) Object.defineProperty(HTMLMediaElement.prototype, "duration", original);
    }
  });

  it("shows the total time when the metadata loaded before the listeners", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration");
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get: () => 79.53,
    });
    try {
      render(<MediaPlayer src="/a.mp4" />);
      expect(await screen.findByText(/1:19/)).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(HTMLMediaElement.prototype, "duration", original);
    }
  });
});

describe("media player progress", () => {
  it("moves the progress bar every animation frame while playing", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration");
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get: () => 50,
    });
    try {
      const { container } = render(<MediaPlayer src="/a.mp4" />);
      const video = container.querySelector("video") as HTMLVideoElement;

      // `timeupdate` alone fires ~4x/s and made the bar jump; the frame loop
      // must read the element while playing.
      act(() => {
        video.dispatchEvent(new Event("play"));
      });
      video.currentTime = 12.5;
      act(() => {
        frames.shift()?.(performance.now());
      });

      // duration 50 s, currentTime 12.5 s → the played fill sits at 25%.
      expect(container.querySelector('[style*="width: 25%"]')).toBeTruthy();
      expect(frames.length).toBeGreaterThan(0);

      act(() => {
        video.dispatchEvent(new Event("pause"));
      });
      expect(cancel).toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(HTMLMediaElement.prototype, "duration", original);
      raf.mockRestore();
      cancel.mockRestore();
    }
  });
});

describe("media player audio waveform", () => {
  it("fills the bars up to the seeked position", () => {
    const { container } = render(<MediaPlayer src="/a.mp3" kind="audio" />);
    const slider = container.querySelector('[role="slider"]') as HTMLElement;
    expect(slider).toBeTruthy();
    // jsdom lays everything out at 0×0: give the slider a width so a clientX
    // maps to a seek ratio.
    slider.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 32, width: 100, height: 32, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 });

    const bars = Array.from(slider.querySelectorAll("span"));
    expect(bars).toHaveLength(44);
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    // Half the bars take the played colour, the rest stay idle.
    const played = bars.filter((b) => (b as HTMLElement).style.background.includes("accent"));
    expect(played.length).toBe(22);
  });
});
