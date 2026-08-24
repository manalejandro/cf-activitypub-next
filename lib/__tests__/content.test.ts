import { describe, it, expect } from "vitest";
import { processStatusContent, linkifyInline, linkifyHtmlText, statusHtmlToPlain, apAttachmentType } from "@/lib/activitypub/content";

describe("processStatusContent URL vs hashtag handling", () => {
  it("does not treat a #fragment inside a URL as a hashtag", () => {
    const url = "https://github.com/manalejandro/cf-activitypub-next/blob/main/components/APTypeBlock.tsx#L33-L42";
    const { html, tags } = processStatusContent(url);

    // The whole URL must be one single link that points at the original URL.
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`${url}</a>`);
    expect(html).toMatch(/<a[^>]+href="https:\/\/github\.com[^>]*>https:\/\/github\.com[\s\S]*<\/a>/);

    // No fragment/tag link should be produced.
    expect(html).not.toContain('/tags/l33');
    expect(html).not.toContain('class="tag"');

    // No Hashtag AP tag should be emitted either.
    expect(tags.some((t) => t.type === "Hashtag")).toBe(false);
  });

  it("still honors real hashtags outside URLs", () => {
    const { html, tags } = processStatusContent("post #cats hello https://example.com/a#section world #dogs");
    expect(tags.filter((t) => t.type === "Hashtag").map((t) => t.name)).toEqual(["#cats", "#dogs"]);
    expect(html).toContain('href="https://example.com/a#section"');
    expect(html).not.toContain('/tags/section');
  });

  it("renders remote mentions as @user display with a full link", () => {
    const { html, tags } = processStatusContent("hola @alice@example.com!");

    // Display text shows only the username, not the domain.
    expect(html).toContain(">@<span>alice</span></a>");
    expect(html).not.toContain(">@<span>alice@example.com</span></a>");

    // The link target and the AP Mention tag keep the full handle/address.
    expect(html).toContain('href="https://example.com/@alice"');
    expect(html).toContain('title="@alice@example.com"');
    expect(tags).toContainEqual({ type: "Mention", href: "https://example.com/@alice", name: "@alice@example.com" });
  });

  it("linkifies a URL containing an @ before resolving it as a mention", () => {
    const url = "https://example.com/@alice";
    const { html, tags } = processStatusContent(`mira ${url} y luego @bob@example.com`);

    // The whole URL stays a single link; the @ inside it must not become a mention.
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`>${url}</a>`);
    expect(html).not.toContain(`/@alice" class="u-url mention"`);
    expect(tags.some((t) => t.type === "Mention" && t.href === url)).toBe(false);

    // Mentions outside the URL are still resolved normally.
    expect(html).toContain('href="https://example.com/@bob"');
    expect(tags).toContainEqual({ type: "Mention", href: "https://example.com/@bob", name: "@bob@example.com" });
  });
});
describe("linkifyInline", () => {
  it("linkifies URLs, mentions, and hashtags without paragraph wrapping", () => {
    const html = linkifyInline("hola https://example.com @alice@remote.example #cats", "https://local.example");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('href="https://remote.example/@alice"');
    expect(html).toContain('href="/tags/cats"');
    expect(html).not.toContain("<p>");
  });

  it("preserves single newlines as <br />", () => {
    const html = linkifyInline("linea1\nlinea2");
    expect(html).toBe("linea1<br />linea2");
  });

  it("linkifies local mentions to /users/...", () => {
    const html = linkifyInline("@admin hola", "https://local.example");
    expect(html).toContain('href="https://local.example/users/admin"');
  });
});

describe("linkifyHtmlText", () => {
  it("linkifies unlinked URLs, mentions and hashtags inside <p>-wrapped text", () => {
    const html = linkifyHtmlText(
      "<p>Mira https://example.com y @alice@remote.example #cats</p>",
      "https://local.example"
    );
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('href="https://remote.example/@alice"');
    expect(html).toContain('href="/tags/cats"');
    expect(html).toContain("<p>");
  });

  it("leaves already-linked content untouched", () => {
    const html = linkifyHtmlText(
      '<p>hola <a href="https://example.com" class="mention">@bob@example.com</a> https://other.example</p>',
      "https://local.example"
    );
    expect(html).toContain('<a href="https://example.com" class="mention">');
    expect(html).toContain('href="https://other.example"');
    expect(html).toMatch(/class="mention"[^>]*>@bob@example.com<\/a>/);
  });

  it("does not linkify content inside pre/code blocks", () => {
    const html = linkifyHtmlText(
      "<p>texto <code>https://no-link.example</code> @alice@remote.example</p>",
      "https://local.example"
    );
    expect(html).toContain("<code>https://no-link.example</code>");
    expect(html).not.toContain('href="https://no-link.example"');
    expect(html).toContain('href="https://remote.example/@alice"');
  });

  it("linkifies custom emoji shortcodes in HTML text", () => {
    const html = linkifyHtmlText("<p>hola :blobcat:</p>", "https://local.example", [{
      id: "e1", shortcode: "blobcat", url: "https://local.example/emoji/blobcat.png",
      staticUrl: "https://local.example/emoji/blobcat.png", category: null, visibleInPicker: false,
      domain: null, actorId: null, disabled: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }]);
    expect(html).toContain('class="emojione"');
  });
});

describe("statusHtmlToPlain", () => {
  it("restores the full @user@domain handle for remote mentions", () => {
    const { html } = processStatusContent("hola @alice@example.com!");
    expect(html).toContain('title="@alice@example.com"');

    const plain = statusHtmlToPlain(html);
    expect(plain).toBe("hola @alice@example.com!");
  });

  it("round-trips a mixed status with local + remote mentions and hashtags", () => {
    const { html } = processStatusContent(
      "@admin mira esto @alice@example.com #cats",
      "https://local.example"
    );
    const plain = statusHtmlToPlain(html);
    expect(plain).toBe("@admin mira esto @alice@example.com #cats");
  });

  it("preserves paragraphs and line breaks as newlines", () => {
    const { html } = processStatusContent("linea uno\nlinea dos\n\nparrafo dos", "https://local.example");
    const plain = statusHtmlToPlain(html);
    expect(plain).toBe("linea uno\nlinea dos\n\nparrafo dos");
  });

  it("strips formatting tags but keeps the text", () => {
    const html = '<p>hola <strong>mundo</strong></p>';
    expect(statusHtmlToPlain(html)).toBe("hola mundo");
  });

  it("decodes HTML entities back to plain characters", () => {
    const html = "<p>a &amp; b &lt; c</p>";
    expect(statusHtmlToPlain(html)).toBe("a & b < c");
  });
});

describe("apAttachmentType", () => {
  it("maps image MIME types to image", () => {
    expect(apAttachmentType("Document", "image/jpeg")).toBe("image");
    expect(apAttachmentType("Document", "image/png")).toBe("image");
  });

  it("maps gif MIME types to gifv", () => {
    expect(apAttachmentType("Document", "image/gif")).toBe("gifv");
  });

  it("maps video and audio MIME types", () => {
    expect(apAttachmentType("Document", "video/mp4")).toBe("video");
    expect(apAttachmentType("Document", "audio/mpeg")).toBe("audio");
  });

  it("falls back to the AP type lowercased", () => {
    expect(apAttachmentType("Image", undefined)).toBe("image");
    expect(apAttachmentType("Audio", null)).toBe("audio");
  });

  it("defaults untyped Document attachments to image", () => {
    expect(apAttachmentType("Document", undefined)).toBe("image");
    expect(apAttachmentType(undefined, undefined)).toBe("image");
  });

  it("is case-insensitive", () => {
    expect(apAttachmentType("document", "VIDEO/MP4")).toBe("video");
  });
});
