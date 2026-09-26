import { describe, it, expect } from "vitest";
import { linkifyHtmlText, processStatusContent } from "@/lib/activitypub/content";

const MD = { markdown: true } as const;
const BASE = "https://local.example";

describe("Markdown authoring (content_type: text/markdown)", () => {
  it("renders headings as the bold paragraphs Mastodon displays", () => {
    const { html } = processStatusContent("### Severity\n\nLow", BASE, undefined, MD);
    expect(html).toContain("<p><strong>Severity</strong></p>");
    expect(html).toContain("<p>Low</p>");
    expect(html).not.toContain("###");
  });

  it("renders bold, italics, strikethrough and inline code", () => {
    const { html } = processStatusContent(
      "The vulnerable code was introduced in **v4.4.0** on `main` and _maybe_ ~~removed~~ later.",
      BASE,
      undefined,
      MD
    );
    expect(html).toContain("<strong>v4.4.0</strong>");
    expect(html).toContain("<code>main</code>");
    expect(html).toContain("<em>maybe</em>");
    expect(html).toContain("<del>removed</del>");
  });

  it("keeps fenced code blocks literal (no linkification inside)", () => {
    const { html } = processStatusContent(
      "```\ncurl https://remote.example/@user #tag\n```",
      BASE,
      undefined,
      MD
    );
    expect(html).toContain("<pre><code>");
    expect(html).toContain("https://remote.example/@user");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("/tags/");
  });

  it("renders lists and blockquotes", () => {
    const { html } = processStatusContent(
      "- first\n- second\n\n1. one\n2. two\n\n> quoted line",
      BASE,
      undefined,
      MD
    );
    expect(html).toContain("<ul><li>first</li><li>second</li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain("<blockquote>quoted line</blockquote>");
  });

  it("renders markdown links and keeps mentions/hashtags linkified", () => {
    const { html, tags } = processStatusContent(
      "See [the report](https://example.org/advisory) by @alice and #security",
      BASE,
      undefined,
      MD
    );
    expect(html).toContain('href="https://example.org/advisory"');
    expect(html).toContain(">the report</a>");
    expect(html).toContain("mention");
    expect(html).toContain("/tags/security");
    expect(tags.some((t) => t.type === "Hashtag")).toBe(true);
  });

  it("escapes HTML so Markdown authoring cannot inject tags", () => {
    const { html } = processStatusContent("<script>alert(1)</script>", BASE, undefined, MD);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not turn block separators into stray line breaks when serializing", () => {
    const { html } = processStatusContent(
      "### A\n\nText with https://example.org",
      BASE,
      undefined,
      MD
    );
    const serialized = linkifyHtmlText(html, BASE);
    expect(serialized).not.toContain("</p><br");
    expect(serialized).toContain("</p>\n<p>");
    expect(serialized).toContain('href="https://example.org"');
  });

  it("keeps plain text unchanged when markdown is not requested", () => {
    const { html } = processStatusContent("### Severity\n\n**v4.4.0**", BASE);
    expect(html).toContain("### Severity");
    expect(html).toContain("**v4.4.0**");
  });
});
