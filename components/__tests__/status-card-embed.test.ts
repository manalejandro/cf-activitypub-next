import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/i18n", () => ({
  useLocale: () => ({ t: {}, locale: "en" }),
  translateKey: (t: unknown, key: string) => key,
}));

import { playableCardEmbedUrl } from "@/components/StatusCard";

describe("playableCardEmbedUrl", () => {
  it("does not offer a player for a rich page embed (WordPress post)", () => {
    // Reported: a WordPress oEmbed rich card showed a play button over an empty
    // box even though the embed is a post preview, not media.
    expect(
      playableCardEmbedUrl({
        type: "rich",
        embed_url: "https://tecnoysoft.com/2026/05/30/como-migrar-a-linux/embed/#?secret=abc",
        url: "https://tecnoysoft.com/2026/05/30/como-migrar-a-linux/",
      })
    ).toBeNull();
  });

  it("does not offer a player for a Mastodon status embed either", () => {
    expect(
      playableCardEmbedUrl({
        type: "rich",
        embed_url: "https://mastodon.social/@user/123/embed",
        url: "https://mastodon.social/@user/123",
      })
    ).toBeNull();
  });

  it("plays real provider players typed as video", () => {
    expect(
      playableCardEmbedUrl({ type: "video", embed_url: "https://player.vimeo.com/video/12345" })
    ).toBe("https://player.vimeo.com/video/12345");
    expect(
      playableCardEmbedUrl({ type: "video", embed_url: "https://koreus.tv/videos/embed/abc" })
    ).toBe("https://koreus.tv/videos/embed/abc");
  });

  it("always plays YouTube, whatever type the snapshot carries", () => {
    expect(playableCardEmbedUrl({ type: "rich", url: "https://youtu.be/9-hgsC-JxaI" })).toBe(
      "https://www.youtube-nocookie.com/embed/9-hgsC-JxaI"
    );
    expect(
      playableCardEmbedUrl({ type: "link", embed_url: "https://www.youtube.com/embed/abc123" })
    ).toBe("https://www.youtube.com/embed/abc123");
  });

  it("leaves plain link and photo cards without a player", () => {
    expect(playableCardEmbedUrl({ type: "link", url: "https://news.example/story" })).toBeNull();
    expect(
      playableCardEmbedUrl({ type: "photo", embed_url: "https://cdn.example/photo.jpg" })
    ).toBeNull();
  });
});
