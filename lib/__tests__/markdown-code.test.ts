// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isInsideMarkdownCode, maskMarkdownCode } from "@/lib/markdown-code";
import { findMentionQuery } from "@/lib/account-autocomplete";
import { findTagQuery } from "@/lib/tag-autocomplete";
import { findEmojiQuery } from "@/lib/emoji-autocomplete";
import { processStatusContent } from "@/lib/activitypub/content";
import { expandBareMentions } from "@/lib/activitypub/replies";

describe("Markdown code awareness", () => {
  it("detects fenced code blocks and inline code spans", () => {
    const fenced = "```ruby\nstatus.quote # nil\n```";
    expect(isInsideMarkdownCode(fenced, fenced.indexOf("quote"))).toBe(true);
    expect(isInsideMarkdownCode(fenced, fenced.length)).toBe(false);

    const inline = "use `@options` here";
    expect(isInsideMarkdownCode(inline, inline.indexOf("options"))).toBe(true);
    expect(isInsideMarkdownCode(inline, inline.length)).toBe(false);
  });

  it("masks code but keeps the string length and newlines", () => {
    const text = "a `code` b\n```\nmore\n```";
    const masked = maskMarkdownCode(text);
    expect(masked.length).toBe(text.length);
    expect(masked.split("\n").length).toBe(text.split("\n").length);
    expect(masked).not.toContain("code");
    expect(masked).not.toContain("more");
  });

  it("keeps the composer autocompletes quiet inside code", () => {
    const text = "```\nfido: @options\n#quote :smile:\n```\n@ali";
    expect(findMentionQuery(text, text.indexOf("@options") + "@options".length)).toBeNull();
    expect(findTagQuery(text, text.indexOf("#quote") + "#quote".length)).toBeNull();
    expect(findEmojiQuery(text, text.indexOf(":smile:") + ":smile:".length)).toBeNull();
    // Outside the fence the same triggers still work.
    expect(findMentionQuery(text, text.length)?.query).toBe("ali");
  });

  it("does not create tags from mentions/hashtags inside code", () => {
    const md = {
      markdown: true,
    } as const;
    const { html, tags } = processStatusContent(
      "```ruby\n@options = {} #quote perform\n```\n\nHola @alice y #seguridad",
      "https://local.example",
      undefined,
      md
    );
    expect(tags.some((t) => t.type === "Mention")).toBe(true);
    expect(tags.some((t) => t.type === "Hashtag")).toBe(true);
    expect(tags.some((t) => (t.name ?? "").includes("options"))).toBe(false);
    expect(tags.some((t) => (t.name ?? "") === "#quote")).toBe(false);
    // The linkifier runs outside the fence only.
    expect(html).toContain("<code>@options = {} #quote perform</code>");
    expect(html).toContain("mention");
    expect(html).toContain("/tags/seguridad");
  });

  it("does not expand bare mentions inside code samples", () => {
    const participants = [{ iri: "https://remote.example/users/alice", username: "alice", domain: "remote.example", handle: "@alice@remote.example" }];
    const text = "```\n@alice\n```\n@alice hola";
    const expanded = expandBareMentions(text, participants, "local.example", { markdown: true });
    expect(expanded).toContain("```\n@alice\n```");
    expect(expanded).toContain("@alice@remote.example hola");
  });
});
