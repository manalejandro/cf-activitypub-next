import { describe, expect, it } from "vitest";
import { buildActor, buildAnnounce, buildFollow, buildLike, buildMove, buildNote, buildRelayFollow, buildUndo, conversationFromRaw, conversationUri, normalizeAttributionDomains } from "@/lib/activitypub/utils";

const BASE = "https://local.example";
const ACTOR = "https://local.example/users/me";
const TARGET = "https://remote.example/users/fan";
const FOLLOWERS = "https://local.example/users/me/followers";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

describe("buildUndo", () => {
  it("never invents an audience: a Follow/Undo pair carries none", () => {
    // Mastodon's FollowSerializer and UndoFollowSerializer have no `to`/`cc`
    // (the relay pair is the same shape).
    const follow = buildFollow(BASE, ACTOR, TARGET, "f1");
    expect("to" in follow).toBe(false);
    expect("cc" in follow).toBe(false);

    const undo = buildUndo(BASE, ACTOR, follow, "u1");
    expect("to" in undo).toBe(false);
    expect("cc" in undo).toBe(false);
    expect(JSON.stringify(undo)).not.toContain(PUBLIC);
  });

  it("keeps a relay Follow (no audience) audience-free", () => {
    const undo = buildUndo(BASE, ACTOR, buildRelayFollow(BASE, ACTOR, "f2"), "u2");
    // The relay Follow carries no `to`/`cc`: the Undo must not invent one.
    expect("to" in undo).toBe(false);
    expect("cc" in undo).toBe(false);
    expect(JSON.parse(JSON.stringify(undo))).not.toHaveProperty("to");
  });

  it("mirrors a public Announce (boost) with its followers cc", () => {
    const undo = buildUndo(BASE, ACTOR, buildAnnounce(BASE, ACTOR, TARGET, "a1", FOLLOWERS), "u3");
    expect(undo.to).toEqual([PUBLIC]);
    expect(undo.cc).toEqual([FOLLOWERS]);
  });

  it("mirrors a Like's (empty) audience", () => {
    const undo = buildUndo(BASE, ACTOR, buildLike(BASE, ACTOR, TARGET, "l1"), "u4");
    expect("to" in undo).toBe(false);
    expect("cc" in undo).toBe(false);
  });

  it("wraps the original activity untouched", () => {
    const follow = buildFollow(BASE, ACTOR, TARGET, "f1");
    const undo = buildUndo(BASE, ACTOR, follow, "u5");
    expect(undo.type).toBe("Undo");
    expect(undo.actor).toBe(ACTOR);
    expect(undo.object).toBe(follow);
    expect(undo.id).toContain("u5");
  });
});

describe("buildLike", () => {
  it("matches Mastodon: no audience (it is delivered to the author only)", () => {
    const like = buildLike(BASE, ACTOR, TARGET, "l1");
    expect(like.type).toBe("Like");
    expect(like.object).toBe(TARGET);
    expect("to" in like).toBe(false);
    expect("cc" in like).toBe(false);
  });
});

describe("buildMove", () => {
  it("carries the moving account as object and the destination as target", () => {
    // Mastodon's Move handler rejects the activity unless the object is the
    // origin account (`origin_account.uri != object_uri` → return).
    const move = buildMove(BASE, ACTOR, TARGET, "m1");
    expect(move.type).toBe("Move");
    expect(move.actor).toBe(ACTOR);
    expect(move.object).toBe(ACTOR);
    expect(move.target).toBe(TARGET);
    expect("to" in move).toBe(false);
  });
});

describe("buildNote", () => {
  const note = (visibility: "public" | "unlisted" | "private" | "direct") =>
    buildNote(BASE, "n1", {
      actorUsername: "me",
      content: "hola",
      published: "2026-01-01T00:00:00Z",
      visibility,
    });

  it("declares the quote policy Mastodon needs to allow quoting", () => {
    const publicNote = note("public") as Record<string, unknown>;
    expect(publicNote.interactionPolicy).toEqual({ canQuote: { automaticApproval: [PUBLIC] } });
    expect((note("unlisted") as Record<string, unknown>).interactionPolicy).toEqual({
      canQuote: { automaticApproval: [PUBLIC] },
    });
    expect((note("private") as Record<string, unknown>).interactionPolicy).toEqual({
      canQuote: { automaticApproval: [FOLLOWERS] },
    });
    expect((note("direct") as Record<string, unknown>).interactionPolicy).toEqual({
      canQuote: { automaticApproval: [ACTOR] },
    });
  });

  it("addresses public, unlisted and followers-only posts like Mastodon", () => {
    const pub = note("public");
    expect(pub.to).toEqual([PUBLIC]);
    expect(pub.cc).toEqual([FOLLOWERS]);
    const unlisted = note("unlisted");
    expect(unlisted.to).toEqual([FOLLOWERS]);
    expect(unlisted.cc).toEqual([PUBLIC]);
    const priv = note("private");
    expect(priv.to).toEqual([FOLLOWERS]);
    expect(priv.cc).toEqual([]);
  });

  it("advertises the likes/shares collections with their counts", () => {
    const withCounts = buildNote(BASE, "n2", {
      actorUsername: "me",
      content: "hola",
      published: "2026-01-01T00:00:00Z",
      visibility: "public",
      favouritesCount: 7,
      reblogsCount: 3,
    }) as unknown as { likes: { id: string; type: string; totalItems: number }; shares: { id: string; totalItems: number } };
    expect(withCounts.likes).toEqual({
      id: `${BASE}/objects/n2/likes`,
      type: "Collection",
      totalItems: 7,
    });
    expect(withCounts.shares).toEqual({
      id: `${BASE}/objects/n2/shares`,
      type: "Collection",
      totalItems: 3,
    });
    expect((note("public") as unknown as { likes: { totalItems: number } }).likes.totalItems).toBe(0);
  });

  it("carries the OStatus conversation and declares its context term", () => {
    const conversation = conversationUri(BASE, "n3", "2026-01-02T10:00:00Z");
    expect(conversation).toBe("tag:local.example,2026-01-02:objectId=n3:objectType=Conversation");

    const reply = buildNote(BASE, "n3", {
      actorUsername: "me",
      content: "hola",
      published: "2026-01-02T10:00:00Z",
      visibility: "public",
      inReplyTo: `${BASE}/objects/parent`,
      conversation,
    }) as unknown as { conversation?: string; "@context": unknown[] };
    expect(reply.conversation).toBe(conversation);
    // The last context object redefines `conversation` as ostatus (the MLS
    // extension uses the same short key for `mls:conversation`).
    const last = reply["@context"].at(-1) as Record<string, unknown>;
    expect(last.conversation).toBe("ostatus:conversation");

    // Without a conversation the note stays untouched (no extra context).
    const plain = note("public") as unknown as { conversation?: string; "@context": unknown[] };
    expect(plain.conversation).toBeUndefined();
    expect((plain["@context"].at(-1) as Record<string, unknown>).conversation).toBe("mls:conversation");
  });
});

describe("conversationFromRaw", () => {
  it("reads the stored conversation and tolerates missing/broken raw", () => {
    expect(conversationFromRaw(JSON.stringify({ conversation: "tag:x" }))).toBe("tag:x");
    expect(conversationFromRaw(JSON.stringify({ id: "x" }))).toBeNull();
    expect(conversationFromRaw(null)).toBeNull();
    expect(conversationFromRaw("not json")).toBeNull();
  });
});

describe("buildActor", () => {
  it("advertises the webfinger handle like Mastodon", () => {
    const actor = buildActor(BASE, "me", { publicKeyPem: "k" });
    expect(actor.webfinger).toBe("me@local.example");
    expect(actor.preferredUsername).toBe("me");
    expect(actor.url).toBe(`${BASE}/@me`);
  });

  it("emits the profile display toggles, memorial, suspended and attribution domains", () => {
    const actor = buildActor(BASE, "me", {
      publicKeyPem: "k",
      memorial: true,
      suspended: true,
      showFeatured: false,
      showMedia: false,
      showMediaReplies: false,
      attributionDomains: ["example.com"],
    });
    expect(actor.memorial).toBe(true);
    expect(actor.suspended).toBe(true);
    expect(actor.showFeatured).toBe(false);
    expect(actor.showMedia).toBe(false);
    expect(actor.showRepliesInMedia).toBe(false);
    expect(actor.attributionDomains).toEqual(["example.com"]);

    // Defaults: the toggles are always sent (true); the flags and the domains
    // only when set.
    const plain = buildActor(BASE, "me", { publicKeyPem: "k" });
    expect(plain.showFeatured).toBe(true);
    expect(plain.showMedia).toBe(true);
    expect(plain.showRepliesInMedia).toBe(true);
    expect(plain.memorial).toBeUndefined();
    expect(plain.suspended).toBeUndefined();
    expect(plain.attributionDomains).toBeUndefined();
  });
});

describe("normalizeAttributionDomains", () => {
  it("strips schemes and wildcards, dedupes and rejects invalid entries", () => {
    expect(
      normalizeAttributionDomains(["https://example.com", "*.MiWeb.org", "example.com", "not a domain", 7, ""])
    ).toEqual(["example.com", "miweb.org"]);
    expect(normalizeAttributionDomains(undefined)).toEqual([]);
    expect(normalizeAttributionDomains("example.com")).toEqual([]);
  });
});
