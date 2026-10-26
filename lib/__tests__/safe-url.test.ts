// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { safeHttpUrl, safeHttpsUrl, safeMediaUrl, sameOriginRedirect } from "@/lib/safe-url";
import { renderEmojiInHtml } from "@/lib/emoji";
import { linkifyHtmlText } from "@/lib/activitypub/content";

const PAYLOAD = 'https://x.example/e.png" onerror="alert(document.cookie)';

describe("safeMediaUrl", () => {
  it("keeps our own relative media paths and absolute http(s) URLs", () => {
    expect(safeMediaUrl("/api/media/cache/media/x.mp3")).toBe("/api/media/cache/media/x.mp3");
    expect(safeMediaUrl("https://remote.example/a.png")).toBe("https://remote.example/a.png");
  });

  it("rejects the schemes and shapes that execute or escape an attribute", () => {
    expect(safeMediaUrl("javascript:alert(1)")).toBeNull();
    expect(safeMediaUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeMediaUrl("//evil.example/x.png")).toBeNull();
    expect(safeMediaUrl("/\\evil.example/x.png")).toBeNull();
    expect(safeMediaUrl("")).toBeNull();
    expect(safeMediaUrl(null)).toBeNull();
    expect(safeMediaUrl(42)).toBeNull();
  });

  it("neutralises a quote that would break out of src=", () => {
    const url = safeMediaUrl(PAYLOAD);
    // WHATWG parsing percent-encodes the quote, so the attribute cannot close.
    expect(url).not.toContain('"');
    expect(url).toContain("%22");
  });
});

describe("safeHttpUrl / safeHttpsUrl", () => {
  it("normalises and bounds", () => {
    expect(safeHttpUrl("HTTP://Example.COM/a b")).toBe("http://example.com/a%20b");
    expect(safeHttpsUrl("http://example.com/a")).toBeNull();
    expect(safeHttpsUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHttpUrl(`https://example.com/${"a".repeat(4000)}`, 100)).toHaveLength(100);
  });
});

describe("emoji rendering (stored XSS regression)", () => {
  const emojis = [{ shortcode: "boom", url: PAYLOAD, static_url: PAYLOAD }];

  it("never emits the raw URL of a federated emoji in an attribute", () => {
    const html = renderEmojiInHtml("<p>hola :boom:</p>", emojis);
    // The percent-encoded URL still *reads* `onerror=` as inert data inside
    // src; what must never appear is a raw quote breaking out of the attribute.
    expect(html).not.toContain('" onerror=');
    expect(html).not.toContain('src="https://x.example/e.png"');
    expect(html).toContain("%22");
  });

  it("drops the emoji instead of rendering an unsafe URL", () => {
    const html = renderEmojiInHtml("<p>hola :boom:</p>", [
      { shortcode: "boom", url: "javascript:alert(1)", static_url: "javascript:alert(1)" },
    ]);
    expect(html).toBe("<p>hola :boom:</p>");
  });

  it("keeps working for a normal https emoji", () => {
    const html = renderEmojiInHtml("<p>:boom:</p>", [
      { shortcode: "boom", url: "https://cdn.example/boom.png", static_url: "https://cdn.example/boom.png" },
    ]);
    expect(html).toContain('<img src="https://cdn.example/boom.png"');
  });

  it("escapes the emoji URL on the server-side linkifier too", () => {
    const html = linkifyHtmlText("<p>hola :boom:</p>", "https://cf-ap.com", [
      { shortcode: "boom", url: PAYLOAD, staticUrl: PAYLOAD, visibleInPicker: false, category: null },
    ]);
    expect(html).not.toContain('" onerror=');
    expect(html).toContain("%22");
  });
});

describe("sameOriginRedirect", () => {
  const ORIGIN = "https://cf-ap.com";

  it("keeps same-origin paths with their query and hash", () => {
    expect(sameOriginRedirect("/settings", ORIGIN)).toBe("/settings");
    expect(sameOriginRedirect("/statuses/123?x=1#y", ORIGIN)).toBe("/statuses/123?x=1#y");
    expect(sameOriginRedirect("https://cf-ap.com/home", ORIGIN)).toBe("/home");
  });

  it("refuses the backslash trick that browsers normalize off-origin", () => {
    expect(sameOriginRedirect("/\\evil.com", ORIGIN)).toBe("/home");
    expect(sameOriginRedirect("/\\\\evil.com/x", ORIGIN)).toBe("/home");
  });

  it("refuses protocol-relative and cross-origin targets", () => {
    expect(sameOriginRedirect("//evil.com", ORIGIN)).toBe("/home");
    expect(sameOriginRedirect("https://evil.com/x", ORIGIN)).toBe("/home");
    expect(sameOriginRedirect("javascript:alert(1)", ORIGIN)).toBe("/home");
  });

  it("falls back when there is no target or no usable origin (SSR)", () => {
    expect(sameOriginRedirect(null, ORIGIN)).toBe("/home");
    expect(sameOriginRedirect("", ORIGIN)).toBe("/home");
    expect(sameOriginRedirect("/settings", "")).toBe("/home");
  });
});
