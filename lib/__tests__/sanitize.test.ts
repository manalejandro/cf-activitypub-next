import { describe, it, expect } from "vitest";
import {
  sanitizeFediverseHtml,
  sanitizeFediversePlain,
  sanitizeRemoteNoteContent,
} from "@/lib/activitypub/sanitize";

describe("sanitizeFediverseHtml", () => {
  it("decodes numeric character references to real characters (German quotes)", () => {
    const input =
      "&#8222;Es ist eine widerwärtige, nutzerfeindliche Website&#8220;, erklärte der uBlock-Entwickler bezüglich Facebook.";
    const out = sanitizeFediverseHtml(input)!;
    expect(out).toContain("„Es ist eine widerwärtige, nutzerfeindliche Website“");
    expect(out).not.toContain("&#8222;");
    expect(out).not.toContain("&amp;#8222;");
  });

  it("decodes hexadecimal numeric references too", () => {
    const out = sanitizeFediverseHtml("<p>&#x201E;hallo&#x201C;</p>")!;
    expect(out).toContain("„hallo“");
  });

  it("still escapes real & and > characters in text", () => {
    const out = sanitizeFediverseHtml("<p>a &amp; b &amp; c &gt; d</p>")!;
    expect(out).toContain("a &amp; b &amp; c &gt; d");
  });

  it("does not double-encode already-decoded characters", () => {
    const out = sanitizeFediverseHtml("<p>„comillas“</p>")!;
    expect(out).toContain("„comillas“");
    expect(out).not.toContain("&amp;");
  });

  it("treats invalid code points as U+FFFD", () => {
    expect(sanitizeFediverseHtml("&#0;")).toBe("\uFFFD");
    expect(sanitizeFediverseHtml("&#55296;")).toBe("\uFFFD");
    expect(sanitizeFediverseHtml("&#1114112;")).toBe("\uFFFD");
  });

  it("allows the allowed tags and strips disallowed ones", () => {
    const out = sanitizeFediverseHtml("<p>hola <b>negrita</b> <script>alert(1)</script></p>")!;
    expect(out).toContain("<p>hola <b>negrita</b>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert(1)");
  });
});

describe("sanitizeRemoteNoteContent", () => {
  it("sanitizes article content with numeric entities", () => {
    const input = {
      content: "&#8222;Zitat&#8220; dein Text",
      summary: null,
      sensitive: false,
    };
    const { content } = sanitizeRemoteNoteContent(input.content, input.summary, input.sensitive);
    expect(content).toContain("„Zitat“");
    expect(content).not.toContain("&#8222;");
  });
});

describe("sanitizeFediversePlain", () => {
  it("decodes numeric entities and strips tags from plain text", () => {
    const out = sanitizeFediversePlain("<p>&#8222;hola&#8220;</p>");
    expect(out).toBe("„hola“");
  });
});
describe("URL protocol hardening", () => {
  it("drops javascript: hrefs even with embedded control characters", () => {
    const out = sanitizeFediverseHtml('<p><a href="java\tscript:alert(1)">x</a></p>')!;
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("java	script:");
    expect(out).not.toContain("<a");
  });

  it("keeps https and relative hrefs", () => {
    const out = sanitizeFediverseHtml('<p><a href="https://example.com">x</a> <a href="/local">y</a></p>')!;
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="/local"');
  });

  it("drops non-http(s) image sources (data:, javascript:)", () => {
    const out = sanitizeFediverseHtml('<p><img src="javascript:alert(1)" alt="x"><img src="data:text/html;base64,AA" alt="y"><img src="https://example.com/a.png" alt="z"></p>')!;
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:");
    expect(out).toContain('src="https://example.com/a.png"');
  });
});
