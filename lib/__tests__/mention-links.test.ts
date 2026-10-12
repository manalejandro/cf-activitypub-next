import { describe, it, expect } from "vitest";
import { extractMentionHandles, linkifyHtmlText, processStatusContent } from "@/lib/activitypub/content";
import { serializeStatus } from "@/lib/mastodon/serializers";
import type { LocalActor, LocalObject } from "@/lib/types";

const BASE = "https://local.example";

describe("extractMentionHandles", () => {
  it("splits local and remote handles", () => {
    const { local, remote } = extractMentionHandles("hola @alice y @bob@remote.example y @carol");
    expect(local).toEqual(["alice", "carol"]);
    expect(remote).toEqual([{ user: "bob", domain: "remote.example" }]);
  });
});

describe("processStatusContent with a resolution map", () => {
  it("keeps an @word that resolves to nothing as plain text", () => {
    const mentions = new Map<string, { href: string }>();
    const { html, tags } = processStatusContent("hola @algo, ¿qué tal?", BASE, undefined, { mentions });

    expect(html).not.toContain("<a");
    expect(html).toContain("@algo");
    expect(tags.filter((t) => t.type === "Mention")).toHaveLength(0);
  });

  it("links only the handles that resolved, with their canonical IRI", () => {
    const mentions = new Map<string, { href: string }>([
      ["alice", { href: "https://local.example/users/alice" }],
      ["bob@remote.example", { href: "https://remote.example/users/bob" }],
    ]);
    const { html, tags } = processStatusContent("hola @alice @bob@remote.example y @algo", BASE, undefined, { mentions });

    expect(html).toContain('href="https://local.example/users/alice"');
    // The remote mention links to the canonical actor IRI, not the profile URL.
    expect(html).toContain('href="https://remote.example/users/bob"');
    expect(html).not.toContain("@algo</a>");
    expect(html).toContain("@algo");
    expect(tags.filter((t) => t.type === "Mention").map((t) => t.href)).toEqual([
      "https://local.example/users/alice",
      "https://remote.example/users/bob",
    ]);
  });

  it("still linkifies everything when no map is provided", () => {
    const { html } = processStatusContent("hola @alice", BASE);
    expect(html).toContain('href="https://local.example/users/alice"');
  });
});

describe("linkifyHtmlText with a resolution map", () => {
  it("never turns a bare @word in remote HTML into a local profile link", () => {
    const html = linkifyHtmlText("<p>hola @algo</p>", BASE, undefined, new Map());
    expect(html).not.toContain("<a");
    expect(html).toContain("@algo");
  });

  it("links a declared remote mention to the actor", () => {
    const mentions = new Map([["alice@remote.example", { href: "https://remote.example/users/alice" }]]);
    const html = linkifyHtmlText("<p>hola @alice@remote.example</p>", BASE, undefined, mentions);
    expect(html).toContain('href="https://remote.example/users/alice"');
  });
});

/** Minimal status/actor fixtures: only the fields the serializer reads. */
function statusFixture(text: string, tag: unknown[] = []): { obj: LocalObject; author: LocalActor } {
  const author = {
    id: `${BASE}/users/me`,
    username: "me",
    domain: "local.example",
    displayName: "Me",
    avatarUrl: null,
    isLocal: true,
    isBot: false,
    manuallyApprovesFollowers: false,
    discoverable: true,
    followersCount: 0,
    followingCount: 0,
    statusesCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    publicKeyPem: "pub",
    privateKeyPem: "priv",
    role: "user",
  } as unknown as LocalActor;
  const obj = {
    id: `${BASE}/objects/o1`,
    type: "Note",
    actorId: author.id,
    content: text,
    contentWarning: null,
    sensitive: false,
    visibility: "public",
    inReplyToId: null,
    language: null,
    url: `${BASE}/objects/o1`,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    local: true,
    raw: JSON.stringify({ tag }),
  } as unknown as LocalObject;
  return { obj, author };
}

describe("serializeStatus mention rendering", () => {
  it("never links an @word the status does not declare as a mention", () => {
    const { obj, author } = statusFixture("hola @algo");
    const status = serializeStatus(obj, author, "local.example");
    expect(status.content).not.toContain("/users/algo");
    expect(status.content).toContain("@algo");
  });

  it("links a declared local mention to the actor", () => {
    const { obj, author } = statusFixture("hola @alice", [
      { type: "Mention", href: `${BASE}/users/alice`, name: "@alice@local.example" },
    ]);
    const status = serializeStatus(obj, author, "local.example");
    expect(status.content).toContain(`href="${BASE}/users/alice"`);
  });

  it("links a declared remote mention to its canonical IRI", () => {
    const { obj, author } = statusFixture("hola @bob@remote.example", [
      { type: "Mention", href: "https://remote.example/users/bob", name: "@bob@remote.example" },
    ]);
    const status = serializeStatus(obj, author, "local.example");
    // The remote mention points at the remote account (the app's remote-profile
    // page), never at a local `/users/bob` profile of ours.
    expect(status.content).toContain("remote.example");
    expect(status.content).not.toContain('href="/users/bob"');
    expect(status.content).not.toContain('href="https://local.example/users/bob"');
  });
});
