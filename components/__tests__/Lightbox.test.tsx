import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Lightbox } from "@/components/Lightbox";
import { youTubeEmbedUrl } from "@/lib/youtube";

vi.mock("@/lib/i18n", () => ({
  useLocale: () => ({
    t: {
      a11y_media_viewer: "Media viewer",
      a11y_previous_media: "Previous media",
      a11y_next_media: "Next media",
      action_close: "Close",
      ap_open_original: "Open original",
      media_play: "Play",
      media_pause: "Pause",
      media_mute: "Mute",
      media_unmute: "Unmute",
      media_volume: "Volume",
      media_fullscreen: "Fullscreen",
      media_exit_fullscreen: "Exit fullscreen",
      media_seek: "Seek",
      media_download: "Download",
      action_view_media: "View media",
    },
    locale: "en",
  }),
}));

describe("youTubeEmbedUrl", () => {
  it("accepts privacy-enhanced and regular YouTube embed URLs", () => {
    expect(youTubeEmbedUrl("https://www.youtube-nocookie.com/embed/abc123")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123"
    );
    expect(youTubeEmbedUrl("https://www.youtube.com/embed/xyz")).toBe("https://www.youtube.com/embed/xyz");
  });

  it("rejects other hosts, paths and insecure URLs", () => {
    expect(youTubeEmbedUrl("https://youtube.com.evil.example/embed/x")).toBeNull();
    expect(youTubeEmbedUrl("https://example.com/embed/x")).toBeNull();
    expect(youTubeEmbedUrl("http://www.youtube.com/embed/x")).toBeNull();
    expect(youTubeEmbedUrl("https://www.youtube.com/watch?v=x")).toBeNull();
    expect(youTubeEmbedUrl(null)).toBeNull();
  });
});

describe("Lightbox embeds", () => {
  const base = { index: 0, onClose: () => {}, onNav: () => {} };

  it("renders the YouTube iframe player for embeddable video cards", () => {
    render(
      <Lightbox
        {...base}
        media={[
          {
            url: "https://www.youtube.com/watch?v=abc",
            type: "video",
            embed_url: "https://www.youtube-nocookie.com/embed/abc",
            description: "A video",
          },
        ]}
      />
    );
    const iframe = screen.getByTitle("A video");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/abc");
    expect(iframe).toHaveAttribute("allowfullscreen");
    expect(screen.getByText(/Open original/)).toBeInTheDocument();
  });

  it("derives the embed player from the card URL when embed_url is empty", () => {
    render(
      <Lightbox
        {...base}
        media={[{ url: "https://www.youtube.com/watch?v=abc", type: "video", embed_url: "", description: "Old card" }]}
      />
    );
    const iframe = screen.getByTitle("Old card");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/abc");
  });

  it("falls back to the custom player for disallowed embed hosts", () => {
    const { container } = render(
      <Lightbox
        {...base}
        media={[{ url: "https://example.com/w", type: "video", embed_url: "https://evil.example/embed/x" }]}
      />
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
  });
});
