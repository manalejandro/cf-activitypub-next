// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  acceptsMarkdown,
  accountMarkdownDocument,
  htmlToMarkdown,
  statusMarkdownDocument,
} from "@/lib/markdown-agents";

describe("markdown content negotiation", () => {
  it("opts in only when markdown is asked for", () => {
    expect(acceptsMarkdown("text/markdown")).toBe(true);
    expect(acceptsMarkdown("text/markdown; charset=utf-8, text/html;q=0.5")).toBe(true);
    expect(acceptsMarkdown("text/markdown, */*")).toBe(true);
  });

  it("leaves browsers and API clients alone", () => {
    expect(acceptsMarkdown(null)).toBe(false);
    expect(acceptsMarkdown("")).toBe(false);
    // What a browser sends.
    expect(acceptsMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(acceptsMarkdown("*/*")).toBe(false);
    // Mastodon clients.
    expect(acceptsMarkdown("application/json")).toBe(false);
    expect(acceptsMarkdown("application/activity+json")).toBe(false);
    // HTML is ranked higher.
    expect(acceptsMarkdown("text/markdown;q=0.4, text/html;q=0.9")).toBe(false);
    // Explicitly refused.
    expect(acceptsMarkdown("text/markdown;q=0")).toBe(false);
  });
});

describe("htmlToMarkdown", () => {
  it("keeps paragraphs, line breaks and inline formatting", () => {
    expect(htmlToMarkdown("<p>Hola <strong>mundo</strong> y <em>nada</em></p>")).toBe("Hola **mundo** y *nada*");
    expect(htmlToMarkdown("<p>una<br>dos</p>")).toBe("una\ndos");
    expect(htmlToMarkdown("<p>a</p><p>b</p>")).toBe("a\n\nb");
    expect(htmlToMarkdown("<blockquote><p>cita</p></blockquote>")).toBe("> cita");
    expect(htmlToMarkdown("<ul><li>uno</li><li>dos</li></ul>")).toBe("- uno\n- dos");
    expect(htmlToMarkdown("<p>usa <code>npm</code></p>")).toBe("usa `npm`");
    expect(htmlToMarkdown("<pre><code>const a = 1;</code></pre>")).toBe("```\nconst a = 1;\n```");
  });

  it("renders links and custom emoji", () => {
    expect(htmlToMarkdown('<p><a href="https://example.com/x">ejemplo</a></p>')).toBe("[ejemplo](https://example.com/x)");
    // Mastodon's shortened URLs: the visible part is the label, the full URL
    // the href.
    expect(
      htmlToMarkdown(
        '<p><a href="https://example.com/una/ruta/larga"><span class="invisible">https://</span><span class="ellipsis">example.com/una/ruta</span><span class="invisible">/larga</span></a></p>'
      )
    ).toBe("https://example.com/una/ruta/larga");
    // A link whose label is the URL itself is written as a bare URL.
    expect(htmlToMarkdown('<p><a href="https://example.com">https://example.com</a></p>')).toBe("https://example.com");
    // Custom emoji: the shortcode is what a reader wants, not the image.
    expect(htmlToMarkdown('<p><img src="https://x/emoji.png" alt=":blobcat:" class="emojione"></p>')).toBe(":blobcat:");
    expect(htmlToMarkdown('<p><img src="https://x/foto.png" alt="una foto"></p>')).toBe("![una foto](https://x/foto.png)");
  });

  it("decodes entities, escapes block-looking lines and drops unknown tags", () => {
    expect(htmlToMarkdown("<p>a &amp; b &lt;c&gt; &#39;d&#39;</p>")).toBe("a & b <c> 'd'");
    expect(htmlToMarkdown("<p># no es un titulo</p>")).toBe("\\# no es un titulo");
    expect(htmlToMarkdown("<p>- tampoco una lista</p>")).toBe("\\- tampoco una lista");
    expect(htmlToMarkdown('<p><script>alert(1)</script>hola</p>')).toBe("hola");
    expect(htmlToMarkdown(null)).toBe("");
  });
});

describe("markdown documents", () => {
  it("builds a status document with its context and metrics", () => {
    const md = statusMarkdownDocument({
      url: "https://cf-ap.com/statuses/abc",
      apId: "https://cf-ap.com/objects/abc",
      author: { acct: "ana", displayName: "Ana", url: "https://cf-ap.com/@ana" },
      published: "2026-10-20T10:00:00Z",
      visibility: "public",
      content: "<p>Hola <strong>mundo</strong></p>",
      contentWarning: "spoilers",
      attachments: [{ type: "image", url: "https://cf-ap.com/media/1.jpg", description: "una foto" }],
      poll: { options: [{ title: "sí", votes: 2 }, { title: "no", votes: 1 }], votesCount: 3 },
      card: { url: "https://example.com", title: "Ejemplo", description: "Una web" },
      counts: { replies: 1, reblogs: 2, favourites: 3 },
    });

    expect(md).toContain("# Ana (@ana)");
    expect(md).toContain("> **spoilers**");
    expect(md).toContain("Hola **mundo**");
    expect(md).toContain("![una foto](https://cf-ap.com/media/1.jpg)");
    expect(md).toContain("- sí — 2");
    expect(md).toContain("[Ejemplo](https://example.com)");
    expect(md).toContain("- Replies: 1 · Boosts: 2 · Favourites: 3");
    expect(md).toContain("- Permalink: https://cf-ap.com/statuses/abc");
    expect(md).toContain("- ActivityPub: https://cf-ap.com/objects/abc");
  });

  it("builds a profile document with its fields and recent posts", () => {
    const md = accountMarkdownDocument({
      acct: "ana",
      displayName: "Ana",
      url: "https://cf-ap.com/@ana",
      apId: "https://cf-ap.com/users/ana",
      note: "<p>Bio con <a href=\"https://ejemplo.com\">enlace</a></p>",
      fields: [{ name: "Web", value: '<a href="https://ana.example">ana.example</a>' }],
      counts: { followers: 10, following: 5, statuses: 42 },
      createdAt: "2026-01-01T00:00:00Z",
      posts: [{ url: "https://cf-ap.com/statuses/1", published: "2026-10-20T10:00:00Z", content: "<p>Hola</p>" }],
    });

    expect(md).toContain("# Ana (@ana)");
    expect(md).toContain("Bio con [enlace](https://ejemplo.com)");
    expect(md).toContain("- **Web**: https://ana.example");
    expect(md).toContain("- Followers: 10 · Following: 5 · Posts: 42");
    expect(md).toContain("## Recent posts");
    expect(md).toContain("Hola");
  });
});
