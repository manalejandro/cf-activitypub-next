import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseHandle,
  mentionKey,
  collectThreadParticipants,
  buildReplyMentions,
  expandBareMentions,
} from "@/lib/activitypub/replies";
import type { LocalObject } from "@/lib/types";

const mockGetActorById = vi.hoisted(() => vi.fn());
const mockGetObjectById = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  getActorById: mockGetActorById,
  getObjectById: mockGetObjectById,
}));

const BASE = "https://example.test";

function makeObject(overrides: Partial<LocalObject> = {}): LocalObject {
  return {
    id: "https://remote.example/objects/1",
    type: "Note",
    actorId: "https://remote.example/users/alice",
    content: "<p>hello</p>",
    contentWarning: null,
    sensitive: false,
    visibility: "public",
    inReplyToId: null,
    quoteId: null,
    language: null,
    url: "https://remote.example/objects/1",
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    local: false,
    raw: "{}",
    ...overrides,
  };
}

beforeEach(() => {
  mockGetActorById.mockReset();
  mockGetObjectById.mockReset();
});

describe("parseHandle", () => {
  it("parses remote handles", () => {
    expect(parseHandle("@alice@example.com")).toEqual({ username: "alice", domain: "example.com" });
  });

  it("parses bare local handles", () => {
    expect(parseHandle("@alice")).toEqual({ username: "alice", domain: null });
  });

  it("handles empty input", () => {
    expect(parseHandle("")).toEqual({ username: null, domain: null });
    expect(parseHandle(undefined)).toEqual({ username: null, domain: null });
  });
});

describe("mentionKey", () => {
  it("normalises a mention to username@domain", () => {
    const key = mentionKey({ type: "Mention", href: "https://example.com/users/alice", name: "@alice@example.com" });
    expect(key).toBe("alice@example.com");
  });

  it("falls back to the href when the name is missing", () => {
    const key = mentionKey({ type: "Mention", href: "https://example.com/users/bob" });
    expect(key).toContain("example.com");
  });

  it("returns null for non-mention tags", () => {
    expect(mentionKey({ type: "Hashtag", name: "#tag" })).toBeNull();
  });
});

describe("collectThreadParticipants", () => {
  it("collects the author and mention tags of the parent status", async () => {
    mockGetActorById.mockResolvedValue(null);

    const parent = makeObject({
      actorId: "https://remote.example/users/alice",
      raw: JSON.stringify({
        tag: [
          { type: "Mention", href: "https://remote.example/users/bob", name: "@bob@remote.example" },
          { type: "Hashtag", name: "#test" },
        ],
      }),
    });

    const participants = await collectThreadParticipants({} as never, parent, BASE);
    const iris = participants.map((p) => p.iri);
    expect(iris).toContain("https://remote.example/users/alice");
    expect(iris).toContain("https://remote.example/users/bob");
    expect(iris).toHaveLength(2);

    const bob = participants.find((p) => p.iri === "https://remote.example/users/bob");
    expect(bob?.handle).toBe("@bob@remote.example");
  });

  it("walks up the reply chain and resolves ancestors from the db", async () => {
    mockGetActorById.mockResolvedValue(null);
    mockGetObjectById.mockResolvedValue(
      makeObject({
        id: "https://remote.example/objects/0",
        actorId: "https://remote.example/users/carol",
      })
    );

    const parent = makeObject({
      actorId: "https://remote.example/users/alice",
      inReplyToId: "https://remote.example/objects/0",
    });

    const participants = await collectThreadParticipants({} as never, parent, BASE);
    const iris = participants.map((p) => p.iri);
    expect(iris).toContain("https://remote.example/users/alice");
    expect(iris).toContain("https://remote.example/users/carol");
    expect(mockGetObjectById).toHaveBeenCalledWith({}, "https://remote.example/objects/0");
  });

  it("uses the db actor for local participants (bare handle)", async () => {
    mockGetActorById.mockResolvedValue({
      id: "https://example.test/users/localuser",
      username: "localuser",
      domain: "example.test",
      isLocal: true,
    });

    const parent = makeObject({
      actorId: "https://example.test/users/localuser",
    });

    const participants = await collectThreadParticipants({} as never, parent, BASE);
    expect(participants[0].handle).toBe("@localuser");
  });
});

describe("expandBareMentions", () => {
  const participants = [
    { iri: "https://mastodon.example/users/santiago", username: "santiago", domain: "mastodon.example", handle: "@santiago@mastodon.example" },
    { iri: "https://example.test/users/localuser", username: "localuser", domain: "example.test", handle: "@localuser" },
  ];

  it("expands bare mentions matching a remote participant", () => {
    const out = expandBareMentions("@santiago test", participants, "example.test");
    expect(out).toBe("@santiago@mastodon.example test");
  });

  it("leaves remote handles already carrying a domain untouched", () => {
    const out = expandBareMentions("@santiago@mastodon.example test", participants, "example.test");
    expect(out).toBe("@santiago@mastodon.example test");
  });

  it("does not touch local participants", () => {
    const out = expandBareMentions("@localuser test", participants, "example.test");
    expect(out).toBe("@localuser test");
  });

  it("does not expand unknown bare mentions", () => {
    const out = expandBareMentions("@nobody test", participants, "example.test");
    expect(out).toBe("@nobody test");
  });

  it("keeps the domain off an email-like username edge", () => {
    // a remote mention is written with its domain, so the bare match is only for
    // usernames NOT followed by @domain
    const out = expandBareMentions("write to @santiago today", participants, "example.test");
    expect(out).toBe("write to @santiago@mastodon.example today");
  });
});

describe("buildReplyMentions", () => {
  it("emits tags for participants not already mentioned, excluding self", async () => {
    mockGetActorById.mockImplementation(async (iri: string) => {
      if (iri === "https://remote.example/users/alice") {
        return { id: iri, username: "alice", domain: "remote.example", isLocal: false };
      }
      if (iri === "https://remote.example/users/bob") {
        return { id: iri, username: "bob", domain: "remote.example", isLocal: false };
      }
      return null;
    });

    const parent = makeObject({
      actorId: "https://remote.example/users/alice",
      raw: JSON.stringify({
        tag: [{ type: "Mention", href: "https://remote.example/users/bob", name: "@bob@remote.example" }],
      }),
    });

    // self = alice → bob is the only remaining participant; it never builds
    // visible text (the composer already pre-fills handles into the message).
    const result = await buildReplyMentions({} as never, parent, BASE, "https://remote.example/users/alice", new Set());
    expect(result.tags).toEqual([{ type: "Mention", href: "https://remote.example/users/bob", name: "@bob@remote.example" }]);
  });

  it("skips participants already mentioned by the user", async () => {
    mockGetActorById.mockImplementation(async (iri: string) => {
      return { id: iri, username: "alice", domain: "remote.example", isLocal: false };
    });

    const parent = makeObject({ actorId: "https://remote.example/users/alice" });
    const already = new Set(["alice@remote.example"]);
    const result = await buildReplyMentions({} as never, parent, BASE, "https://example.test/users/me", already);
    expect(result.tags).toEqual([]);
  });

  it("treats a local-resolved bare mention as covering a remote participant of the same username", async () => {
    mockGetActorById.mockImplementation(async (iri: string) => {
      return { id: iri, username: "santiago", domain: "mastodon.example", isLocal: false };
    });

    // The user typed @santiago (no domain); the linkifier resolves it to the
    // local instance (santiago@example.test), which must still count as already
    // mentioning the remote thread participant santiago@mastodon.example.
    const parent = makeObject({ actorId: "https://mastodon.example/users/santiago" });
    const already = new Set(["santiago@example.test"]);
    const result = await buildReplyMentions({} as never, parent, BASE, "https://example.test/users/me", already);
    expect(result.tags).toEqual([]);
  });

  it("emits a bare Mention tag for participants that cannot be resolved", async () => {
    mockGetActorById.mockResolvedValue(null);

    const parent = makeObject({
      actorId: "https://remote.example/users/alice",
      raw: JSON.stringify({
        tag: [
          { type: "Mention", href: "https://remote.example/users/bob", name: "@bob@remote.example" },
          { type: "Mention", href: "https://remote.example/users/carol" },
        ],
      }),
    });

    const result = await buildReplyMentions({} as never, parent, BASE, "https://remote.example/users/alice", new Set());
    // bob resolves via the tag name → tag with name; carol has no name → bare tag
    expect(result.tags).toEqual([
      { type: "Mention", href: "https://remote.example/users/bob", name: "@bob@remote.example" },
      { type: "Mention", href: "https://remote.example/users/carol" },
    ]);
  });
});
