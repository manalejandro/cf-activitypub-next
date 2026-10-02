import { describe, it, expect } from "vitest";
import { renderEmojiInHtml, buildEmojiMap } from "@/lib/emoji";

describe("renderEmojiInHtml", () => {
  const emojis = [
    { shortcode: "blobaww", url: "https://example.com/blobaww.png", static_url: "https://example.com/blobaww.png" },
    { shortcode: "blobcat", url: "https://example.com/blobcat.png", static_url: "https://example.com/blobcat.png" },
  ];

  it("returns html unchanged when emojis list is empty", () => {
    expect(renderEmojiInHtml("<p>hello :blobaww:</p>", [])).toBe("<p>hello :blobaww:</p>");
  });

  it("replaces :shortcode: with emoji img tag", () => {
    const result = renderEmojiInHtml("<p>hello :blobaww:</p>", emojis);
    expect(result).toContain('<img src="https://example.com/blobaww.png"');
    expect(result).toContain('alt=":blobaww:"');
    expect(result).toContain('title=":blobaww:"');
    expect(result).toContain("emojione");
  });

  it("replaces multiple shortcodes", () => {
    const result = renderEmojiInHtml("<p>:blobaww: :blobcat:</p>", emojis);
    expect(result).toContain("blobaww.png");
    expect(result).toContain("blobcat.png");
  });

  it("does not replace shortcodes inside HTML tags", () => {
    const result = renderEmojiInHtml('<p class=":blobaww:">hello</p>', emojis);
    expect(result).toContain(':blobaww:');
    expect(result).not.toContain("blobaww.png");
  });

  it("keeps unmatched shortcodes as-is", () => {
    const result = renderEmojiInHtml("<p>:unknown:</p>", emojis);
    expect(result).toBe("<p>:unknown:</p>");
  });

  it("handles empty string", () => {
    expect(renderEmojiInHtml("", emojis)).toBe("");
  });
});

describe("buildEmojiMap", () => {
  const emojis = [
    { shortcode: "blobaww", url: "a.png", static_url: "a.png" },
    { shortcode: "blobcat", url: "b.png", static_url: "b.png" },
  ];

  it("builds a Map from emoji array", () => {
    const map = buildEmojiMap(emojis);
    expect(map.size).toBe(2);
    expect(map.get("blobaww")?.url).toBe("a.png");
    expect(map.get("blobcat")?.url).toBe("b.png");
  });

  it("returns empty map for empty array", () => {
    const map = buildEmojiMap([]);
    expect(map.size).toBe(0);
  });
});
