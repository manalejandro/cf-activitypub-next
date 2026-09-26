// @vitest-environment node
import { describe, it, expect } from "vitest";
import { serializeStatus } from "@/lib/mastodon/serializers";
import type { LocalActor, LocalObject } from "@/lib/types";

function statusWith(content: string) {
  const obj = {
    id: "https://local.example/objects/1",
    type: "Note",
    actorId: "https://local.example/users/me",
    content,
    contentWarning: null,
    sensitive: false,
    visibility: "public",
    inReplyToId: null,
    language: "en",
    url: null,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    engagement: 0,
    published: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    isLocal: true,
    // No structured `tag` array → the serializer uses its HTML fallback.
    raw: JSON.stringify({ id: "https://local.example/objects/1", type: "Note" }),
    mediaPending: 0,
  } as unknown as LocalObject;
  const author = {
    id: "https://local.example/users/me",
    username: "me",
    domain: "local.example",
  } as unknown as LocalActor;
  return serializeStatus(obj, author, "local.example");
}

describe("hashtag extraction from rendered HTML", () => {
  it("does not swallow HTML entities into a numeric token (#34480&quot;)", () => {
    const status = statusWith('<p>&quot;Reject incoming QuoteRequest activities #34480&quot;) and more</p>');
    expect(status.tags).toEqual([]);
  });

  it("ignores numeric-only tokens (Mastodon requires a letter)", () => {
    const status = statusWith("<p>Issue #123 and #2026</p>");
    expect(status.tags).toEqual([]);
  });

  it("ignores hashtags inside code samples", () => {
    const status = statusWith('<p>Run <code>quote_request.rb #perform</code> and #security</p>');
    expect(status.tags.map((t) => t.name)).toEqual(["security"]);
  });

  it("still extracts real hashtags and links them locally", () => {
    const status = statusWith("<p>Hola #seguridad y #Café, issue #34480</p>");
    expect(status.tags.map((t) => t.name)).toEqual(["seguridad", "café"]);
    expect(status.tags[0].url).toContain("/tags/seguridad");
  });
});
