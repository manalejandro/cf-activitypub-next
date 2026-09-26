import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MediaPlayer, formatMediaTime } from "@/components/MediaPlayer";

vi.mock("@/lib/i18n", () => ({
  useLocale: () => ({
    t: {
      media_play: "Play",
      media_pause: "Pause",
      media_mute: "Mute",
      media_unmute: "Unmute",
      media_volume: "Volume",
      media_fullscreen: "Fullscreen",
      media_exit_fullscreen: "Exit fullscreen",
      media_seek: "Seek",
      media_download: "Download",
      media_expand: "Open media viewer",
    },
    locale: "en",
  }),
}));

const playSpy = vi.fn();
const pauseSpy = vi.fn();

beforeEach(() => {
  playSpy.mockClear();
  pauseSpy.mockClear();
  // jsdom does not implement media playback: emulate play/pause so the
  // component's state transitions can be observed.
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: function (this: HTMLMediaElement) {
      playSpy();
      Object.defineProperty(this, "paused", { configurable: true, value: false });
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: function (this: HTMLMediaElement) {
      pauseSpy();
      Object.defineProperty(this, "paused", { configurable: true, value: true });
      this.dispatchEvent(new Event("pause"));
    },
  });
});

describe("formatMediaTime", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatMediaTime(0)).toBe("0:00");
    expect(formatMediaTime(65)).toBe("1:05");
    expect(formatMediaTime(3661)).toBe("1:01:01");
    expect(formatMediaTime(NaN)).toBe("0:00");
    expect(formatMediaTime(-4)).toBe("0:00");
  });
});

describe("MediaPlayer", () => {
  it("plays and pauses a video with the custom controls", () => {
    const { container } = render(<MediaPlayer src="https://local.example/media/video.mp4" kind="video" />);
    expect(container.querySelector("video")).toHaveAttribute("src", "https://local.example/media/video.mp4");

    // While paused both the overlay and the control bar expose Play.
    fireEvent.click(screen.getAllByLabelText("Play")[0]);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Pause")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Pause"));
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(screen.getAllByLabelText("Play").length).toBeGreaterThan(0);
  });

  it("mutes with the keyboard shortcut", () => {
    const { container } = render(<MediaPlayer src="https://local.example/media/video.mp4" kind="video" />);
    const player = container.querySelector(".media-player")!;
    fireEvent.keyDown(player, { key: "m" });
    expect(screen.getAllByLabelText("Unmute").length).toBeGreaterThan(0);
  });

  it("renders the audio player with a waveform scrubber", () => {
    const { container } = render(
      <MediaPlayer src="https://local.example/media/song.mp3" kind="audio" description="A song" />
    );
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    expect(screen.getByText("A song")).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText("Play")[0]);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector("audio")).not.toBeNull();
  });

  it("autoplays GIFVs inline without player controls", () => {
    const { container } = render(
      <MediaPlayer src="https://local.example/media/cat.gif" kind="gifv" autoPlay loop muted />
    );
    expect(screen.queryByLabelText("Play")).toBeNull();
    expect(screen.queryByRole("slider", { name: "Seek" })).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
  });
});
