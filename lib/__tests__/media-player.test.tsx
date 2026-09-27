import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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
