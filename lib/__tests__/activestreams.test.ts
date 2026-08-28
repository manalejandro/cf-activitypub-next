import { describe, it, expect } from "vitest";
import { isContentObjectType, isActivityType, isActorType, CONTENT_OBJECT_TYPES } from "@/lib/activitypub/vocab";
import { extractAPMeta, rewriteProfileLinks, serializeStatus, serializeAccount, serializeAttachment } from "@/lib/mastodon/serializers";
import type { LocalActor, LocalObject, ActorField, LocalAttachment } from "@/lib/types";

function makeObject(type: string, extra: Record<string, unknown> = {}): LocalObject {
  const rawObj = { id: "https://remote.example/objects/1", type, ...extra };
  return {
    id: "https://remote.example/objects/1",
    type,
    actorId: "https://remote.example/users/a",
    content: (extra.content as string | undefined) ?? "<p>hello</p>",
    contentWarning: null,
    sensitive: false,
    visibility: "public",
    inReplyToId: null,
    language: "en",
    url: "https://remote.example/objects/1",
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    local: false,
    raw: JSON.stringify(rawObj),
  };
}

const author: LocalActor = {
  id: "https://remote.example/users/a",
  username: "a",
  domain: "remote.example",
  displayName: "A",
  summary: null,
  avatarUrl: null,
  headerUrl: null,
  publicKeyPem: "pem",
  privateKeyPem: null,
  isLocal: false,
  isBot: false,
  manuallyApprovesFollowers: false,
  discoverable: true,
  followersCount: 0,
  followingCount: 0,
  statusesCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  email: null,
  passwordHash: null,
  emailVerified: false,
  autoDeleteAfter: null,
};

describe("ActivityStreams vocabulary", () => {
  it("classifies content types, activity types, and actor types", () => {
    for (const t of CONTENT_OBJECT_TYPES) {
      expect(isContentObjectType(t), `expected ${t} to be a content type`).toBe(true);
    }
    expect(isContentObjectType("Tombstone")).toBe(false);
    expect(isContentObjectType("Note")).toBe(true);
    expect(isActivityType("Create")).toBe(true);
    expect(isActivityType("Block")).toBe(true);
    expect(isActivityType("Nonsense")).toBe(false);
    expect(isActorType("Person")).toBe(true);
    expect(isActorType("Service")).toBe(true);
    expect(isActorType("Note")).toBe(false);
  });

  it("covers the core AS2 object types", () => {
    ["Article", "Audio", "Document", "Event", "Image", "Note", "Page", "Place", "Profile", "Relationship", "Tombstone", "Video"]
      .forEach((t) => expect(isContentObjectType(t) || t === "Tombstone" || t === "Profile" || t === "Relationship").toBe(true));
  });
});

describe("extractAPMeta", () => {
  it("extracts Event metadata (name, startTime, endTime, location)", () => {
    const meta = extractAPMeta(makeObject("Event", {
      name: "FestaJS",
      startTime: "2026-05-01T10:00:00Z",
      endTime: "2026-05-01T18:00:00Z",
      location: { type: "Place", name: "W3C HQ", latitude: 48.756, longitude: 2.299 },
    }));
    expect(meta).toMatchObject({
      name: "FestaJS",
      startTime: "2026-05-01T10:00:00Z",
      endTime: "2026-05-01T18:00:00Z",
      location: "W3C HQ",
      latitude: 48.756,
      longitude: 2.299,
    });
  });

  it("extracts a Place with top-level coordinates", () => {
    const meta = extractAPMeta(makeObject("Place", { latitude: [40.4], longitude: [-3.7], name: "Madrid" }));
    expect(meta).toMatchObject({ name: "Madrid", latitude: 40.4, longitude: -3.7 });
  });

  it("normalizes duration string to seconds", () => {
    const meta = extractAPMeta(makeObject("Audio", { duration: "63s", url: "https://cdn.example/x.mp3" }));
    expect(meta?.duration).toBe(63);
  });

  it("returns only the url fallback when there is no other type-specific metadata", () => {
    const meta = extractAPMeta(makeObject("Note", { content: "hi" }));
    // The stored object URL is always resolved, so the meta still carries a
    // usable url instead of being null.
    expect(meta).toMatchObject({ url: "https://remote.example/objects/1" });
  });

  it("resolves PeerTube-style top-level Video (watch page + media file)", () => {
    const meta = extractAPMeta(makeObject("Video", {
      name: "Le meilleur GIF l'emporte 🦎",
      duration: "PT68S",
      icon: [{ type: "Image", url: "https://koreus.tv/thumb.jpg", mediaType: "image/jpeg" }],
      url: [
        { type: "Link", mediaType: "text/html", href: "https://koreus.tv/w/4yrZgYN8GJ2rszErUULqe4" },
        { type: "Link", mediaType: "video/mp4", href: "https://koreus.tv/static/web-videos/3c0c0742-e010-481f-82f8-c4089c01a1b4-0.mp4" },
      ],
    }));
    expect(meta).toMatchObject({
      url: "https://koreus.tv/w/4yrZgYN8GJ2rszErUULqe4",
      mediaUrl: "https://koreus.tv/static/web-videos/3c0c0742-e010-481f-82f8-c4089c01a1b4-0.mp4",
      imageUrl: "https://koreus.tv/thumb.jpg",
      duration: 68,
    });
  });

  it("keeps a single plain media URL as both url and mediaUrl", () => {
    const meta = extractAPMeta(makeObject("Audio", { duration: "63s", url: "https://cdn.example/x.mp3" }));
    expect(meta).toMatchObject({ url: "https://cdn.example/x.mp3", mediaUrl: "https://cdn.example/x.mp3" });
    expect(meta?.duration).toBe(63);
  });

  it("resolves ISO 8601 durations with hours/minutes", () => {
    const meta = extractAPMeta(makeObject("Video", { duration: "PT1H2M3S", url: "https://cdn.example/x.mp4" }));
    expect(meta?.duration).toBe(3723);
  });
});

describe("serializeStatus type passthrough", () => {
  it("surfaces ap_type + ap_meta for content objects", () => {
    const status = serializeStatus(makeObject("Event", {
      name: "Taller", startTime: "2026-06-01T09:00:00Z",
      location: { type: "Place", name: "Aula 3" },
    }), author, "local.example");
    expect(status.ap_type).toBe("Event");
    expect(status.ap_meta?.name).toBe("Taller");
    expect(status.ap_meta?.location).toBe("Aula 3");
  });

  it("falls back to the stored object url for a Page without a raw url field", () => {
    const obj = makeObject("Page", { name: "Mi artículo", content: "<p>texto</p>" });
    const status = serializeStatus(obj, author, "local.example");
    expect(status.ap_type).toBe("Page");
    expect(status.ap_meta?.name).toBe("Mi artículo");
    // No raw `url` on the object → the DB column (object id here) is used so
    // the rendered header never produces a dead link.
    expect(status.ap_meta?.url).toBe("https://remote.example/objects/1");
  });

  it("omits ap_type/ap_meta for a plain Note (no badge, no metadata)", () => {
    const status = serializeStatus(makeObject("Note", { content: "hola" }), author, "local.example");
    expect(status.ap_type).toBeUndefined();
    expect(status.ap_meta).toBeUndefined();
  });

  it("omits ap_type/ap_meta for non-renderable object types", () => {
    const status = serializeStatus(makeObject("Object", { content: "hi" }), author, "local.example");
    expect(status.ap_type).toBeUndefined();
    expect(status.ap_meta).toBeUndefined();
  });

  it("surfaces ap_type + ap_meta for Tombstone objects", () => {
    const status = serializeStatus(makeObject("Tombstone", { formerType: "Note", deleted: "2026-01-02T00:00:00Z" }), author, "local.example");
    expect(status.ap_type).toBe("Tombstone");
    expect(status.ap_meta?.formerType).toBe("Note");
    expect(status.ap_meta?.deleted).toBe("2026-01-02T00:00:00Z");
  });
});

describe("serializeStatus content linkification", () => {
  it("linkifies plain-text remote content (URLs, mentions, hashtags)", () => {
    const obj = makeObject("Note", { content: "Mira https://example.com/x y @alice@remote.example #viaje" });
    const status = serializeStatus(obj, author, "local.example");
    expect(status.content).toContain('<a href="https://example.com/x"');
    expect(status.content).toContain('class="u-url mention"');
    expect(status.content).toContain('#viaje');
  });

  it("keeps federated HTML content untouched by the sanitizer", () => {
    const obj = makeObject("Note", { content: "<p>Hola <b>mundo</b> <a href=\"https://example.com\">enlace</a></p>" });
    const status = serializeStatus(obj, author, "local.example");
    expect(status.content).toContain("<b>mundo</b>");
    expect(status.content).toContain('<a href="https://example.com"');
    expect(status.content).toContain("rel=\"nofollow noopener noreferrer\"");
  });

  it("linkifies unlinked text wrapped in <p> tags (PeerTube/WordPress-style)", () => {
    const obj = makeObject("Note", {
      content: "<p>Mira @alice@remote.example https://example.com/x #viaje</p>",
    });
    const status = serializeStatus(obj, author, "local.example");
    expect(status.content).toContain('class="u-url mention"');
    expect(status.content).toContain('<a href="https://example.com/x"');
    expect(status.content).toContain('#viaje');
  });

  it("does not double-link already-linked Mastodon content", () => {
    const obj = makeObject("Note", {
      content: '<p>hola <a href="https://mastodon.example/@bob" class="mention" rel="nofollow">@bob@mastodon.example</a></p>',
    });
    const status = serializeStatus(obj, author, "local.example");
    expect(status.content).toMatch(/class="mention"/);
    expect(status.content).toContain('href="/users/remote?url=' + encodeURIComponent("https://mastodon.example/@bob") + '"');
    expect(status.content).not.toContain('@bob@mastodon.example</p>');
  });

  it("linkifies Video plain-text content (PeerTube-style)", () => {
    const obj = makeObject("Video", { content: "Más info en https://koreus.tv/w/4yrZgYN8GJ2rszErUULqe4 #videos" });
    const status = serializeStatus(obj, author, "local.example");
    expect(status.ap_type).toBe("Video");
    expect(status.content).toContain('<a href="https://koreus.tv/w/4yrZgYN8GJ2rszErUULqe4"');
  });
});

describe("serializeAttachment type fallback", () => {
  const base = (type: string, mimeType: string | null): LocalAttachment => ({
    id: "att1",
    objectId: "obj1",
    type,
    url: "https://cdn.example/video.mp4",
    remoteUrl: null,
    description: null,
    blurhash: null,
    width: null,
    height: null,
    fileSize: null,
    mimeType,
    sensitive: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("classifies by mimeType when present", () => {
    expect(serializeAttachment(base("Video", "video/mp4")).type).toBe("video");
    expect(serializeAttachment(base("Image", "image/jpeg")).type).toBe("image");
    expect(serializeAttachment(base("Document", "image/gif")).type).toBe("gifv");
  });

  it("falls back to the stored AP type when mimeType is missing (brid.gy / Instagram)", () => {
    expect(serializeAttachment(base("video", null)).type).toBe("video");
    expect(serializeAttachment(base("audio", null)).type).toBe("audio");
    expect(serializeAttachment(base("image", null)).type).toBe("image");
  });

  it("returns unknown when neither mimeType nor type is recognizable", () => {
    expect(serializeAttachment(base("bogus", null)).type).toBe("unknown");
  });
});

describe("rewriteProfileLinks", () => {
  it("rewrites remote mention links to the local resolver route", () => {
    const raw = JSON.stringify({
      id: "https://remote.example/objects/1",
      type: "Note",
      tag: [{ type: "Mention", href: "https://remote.example/users/a", name: "@a@remote.example" }],
    });
    const content = '<p>hola <a href="https://remote.example/users/a" class="u-url mention" rel="nofollow noopener noreferrer" target="_blank">@a</a></p>';
    const out = rewriteProfileLinks(content, raw, "local.example");
    expect(out).toContain('href="/users/remote?url=' + encodeURIComponent("https://remote.example/users/a") + '"');
    expect(out).not.toContain("target=\"_blank\"");
    expect(out).not.toContain("https://remote.example/users/a\"");
  });

  it("keeps local and relative links untouched", () => {
    const raw = JSON.stringify({
      id: "https://remote.example/objects/1",
      type: "Note",
      tag: [{ type: "Mention", href: "https://local.example/users/me", name: "@me@local.example" }],
    });
    const content = '<p><a href="https://local.example/users/me" class="mention">@me</a> <a href="/tags/x" class="tag">#x</a></p>';
    const out = rewriteProfileLinks(content, raw, "local.example");
    expect(out).toContain('href="https://local.example/users/me"');
    expect(out).toContain('href="/tags/x"');
  });

  it("rewrites remote mention links via the mention class fallback", () => {
    const content = '<p><a href="https://other.example/@bob" class="u-url mention" rel="nofollow">@bob</a></p>';
    const out = rewriteProfileLinks(content, "{}", "local.example");
    expect(out).toContain('href="/users/remote?url=' + encodeURIComponent("https://other.example/@bob") + '"');
  });

  it("resolves remote hashtag links to the local tag page (Mastodon class=\"mention hashtag\")", () => {
    const content = '<p><a href="https://mastodon.bot/tags/NEWLIV" class="mention hashtag" rel="tag">#NEWLIV</a></p>';
    const out = rewriteProfileLinks(content, "{}", "local.example");
    expect(out).toContain('href="/tags/newliv"');
    expect(out).not.toContain("/users/remote");
    expect(out).not.toContain("mastodon.bot/tags/NEWLIV");
  });

  it("resolves remote hashtag links to the local tag page when the class is just hashtag", () => {
    const content = '<p><a href="https://other.example/tags/cats" class="hashtag" rel="tag">#cats</a></p>';
    const out = rewriteProfileLinks(content, "{}", "local.example");
    expect(out).toContain('href="/tags/cats"');
    expect(out).not.toContain("/users/remote");
  });

  it("keeps ordinary external links untouched", () => {
    const content = '<p><a href="https://example.com/article" target="_blank" rel="nofollow noopener noreferrer">article</a></p>';
    const out = rewriteProfileLinks(content, "{}", "local.example");
    expect(out).toContain('href="https://example.com/article"');
    expect(out).toContain('target="_blank"');
  });
});

describe("serializeAccount local linkification", () => {
  const localAuthor: LocalActor = {
    id: "https://local.example/users/admin",
    username: "admin",
    domain: "local.example",
    displayName: "Admin",
    summary: "Hola https://example.com #news<br />luego @user",
    avatarUrl: null,
    headerUrl: null,
    publicKeyPem: "pem",
    privateKeyPem: null,
    isLocal: true,
    isBot: false,
    manuallyApprovesFollowers: false,
    discoverable: true,
    followersCount: 0,
    followingCount: 0,
    statusesCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    email: null,
    passwordHash: null,
    emailVerified: false,
    autoDeleteAfter: null,
  };

  it("linkifies local bio URLs, hashtags and mentions into HTML", () => {
    const acct = serializeAccount(localAuthor, "local.example");
    expect(acct.note).toContain('href="https://example.com"');
    expect(acct.note).toContain('href="/tags/news"');
    expect(acct.note).toContain('href="https://local.example/users/user"');
    expect(acct.note).toContain("<br />");
  });

  it("linkifies local field values but not remote ones", () => {
    const fields: ActorField[] = [{ id: "f1", actorId: localAuthor.id, name: "Web", value: "https://example.com", position: 0, verifiedAt: null, createdAt: "2026-01-01T00:00:00.000Z" }];
    const acct = serializeAccount(localAuthor, "local.example", { fields });
    expect(acct.fields[0].value).toContain('<a href="https://example.com"');

    const remoteAuthor = { ...author };
    const remoteAcct = serializeAccount(remoteAuthor, "local.example", {
      fields: [{ id: "f2", actorId: remoteAuthor.id, name: "Web", value: '<a href="https://example.com">web</a>', position: 0, verifiedAt: null, createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(remoteAcct.fields[0].value).toContain('href="https://example.com"');
    expect(remoteAcct.fields[0].value).toContain(">web</a>");
  });

  it("keeps remote summaries as-is (already federated HTML)", () => {
    const remoteAuthor = {
      ...author,
      summary: '<p><a href="https://example.com/x" class="mention">@x</a></p>',
    };
    const acct = serializeAccount(remoteAuthor, "local.example");
    expect(acct.note).toContain('<a href="https://example.com/x"');
  });
});