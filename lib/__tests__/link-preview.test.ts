// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

const federation = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  validateOutboundUrl: vi.fn(() => ({ valid: true })),
}));

vi.mock("@/lib/activitypub/federation", () => federation);

import { enqueueLinkPreview, getActorById, getObjectById } from "@/lib/db";
import {
  extractFirstLink,
  parseOpenGraph,
  processLinkPreviewQueue,
  type LinkPreviewBindings,
  type LinkPreviewLimits,
} from "@/lib/link-preview";
import { processMediaCacheQueue, type MediaCacheLimits } from "@/lib/media/remote-cache";
import { parsePreviewCard, serializeStatus } from "@/lib/mastodon/serializers";

class D1Adapter {
  private sql = new DatabaseSync(":memory:");

  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
  }

  async batch(statements: { run(): Promise<D1Result> }[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const s of statements) results.push(await s.run());
    return results;
  }

  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    return {
      bind(...params: unknown[]) {
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            return { results: stmt.all(...(bound as never[])) as unknown as T[], success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            return (stmt.get(...(bound as never[])) as unknown as T | undefined) ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(bound as never[]));
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
    };
  }
}

class FakeR2 {
  store = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

class FakeKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function okResponse(body: Uint8Array, contentType: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: undefined,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function okHtml(html: string): Response {
  return okResponse(new TextEncoder().encode(html) as Uint8Array, "text/html; charset=utf-8");
}

function okJson(payload: unknown): Response {
  return okResponse(new TextEncoder().encode(JSON.stringify(payload)) as Uint8Array, "application/json");
}

const LIMITS: LinkPreviewLimits = {
  enabled: true,
  fetchBatch: 5,
  days: 14,
  maxBytes: 2 * 1024 * 1024,
  userAgents: ["bot-agent", "browser-agent"],
  mediaCacheEnabled: true,
};

const MEDIA_LIMITS: MediaCacheLimits = {
  enabled: true,
  days: 7,
  profileDays: 30,
  maxBytes: 10 * 1024 * 1024,
  maxObjectBytes: 1024 * 1024,
  fetchBatch: 5,
  minEntries: 0,
  userAgents: ["bot-agent"],
};

const ACTOR = "https://remote.example/users/author";
const BASE = "https://local.example";

let db: D1Database;
let r2: FakeR2;
let kv: FakeKV;
let bindings: LinkPreviewBindings;

async function seedObject(id: string, content: string, quoteId: string | null = null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, quote_id)
       VALUES (?, 'Note', ?, ?, 'public', 0, '{}', ?)`
    )
    .bind(id, ACTOR, content, quoteId)
    .run();
}

beforeEach(async () => {
  federation.safeFetch.mockReset();
  federation.validateOutboundUrl.mockReturnValue({ valid: true });
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
  r2 = new FakeR2();
  kv = new FakeKV();
  bindings = { DB: db, KV: kv };
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, 'author', 'remote.example', 'k', NULL, 0)`
    )
    .bind(ACTOR)
    .run();
});

describe("link extraction", () => {
  it("takes the first external link and skips hashtags, mentions and own links", () => {
    const html =
      '<p>Hi <a href="https://remote.example/@bob" class="u-url mention">@bob</a> ' +
      '<a href="https://remote.example/tags/news" rel="tag">#news</a> ' +
      '<a href="https://local.example/objects/1">self</a> ' +
      '<a href="https://news.example/story">story</a></p>';
    expect(extractFirstLink(html, "local.example")).toBe("https://news.example/story");
  });

  it("falls back to plain text URLs", () => {
    expect(extractFirstLink("Check https://news.example/story now", "local.example")).toBe("https://news.example/story");
  });
});

describe("metadata parsing", () => {
  it("parses OpenGraph tags, resolving relative image URLs", () => {
    const card = parseOpenGraph(
      `<html lang="en"><head>
        <title>Fallback</title>
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG &amp; description">
        <meta property="og:image" content="/cover.png">
        <meta property="og:site_name" content="Example News">
        <meta property="og:locale" content="en_US">
        <meta property="article:published_time" content="2026-09-01T10:00:00Z">
      </head></html>`,
      "https://news.example/story"
    );
    expect(card?.title).toBe("OG Title");
    expect(card?.description).toBe("OG & description");
    expect(card?.imageUrl).toBe("https://news.example/cover.png");
    expect(card?.providerName).toBe("Example News");
    expect(card?.language).toBe("en-US");
    expect(card?.publishedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(card?.type).toBe("link");
  });
});

describe("link preview queue", () => {
  it("crawls the first link, stores the card and snapshots it on the status", async () => {
    await seedObject("https://remote.example/objects/1", '<p>Look at <a href="https://news.example/story">this</a></p>');
    await enqueueLinkPreview(db, "https://remote.example/objects/1");
    federation.safeFetch.mockResolvedValueOnce(
      okHtml(`<html><head>
        <meta property="og:title" content="A story">
        <meta property="og:description" content="Something happened">
        <meta property="og:image" content="https://cdn.example/cover.jpg">
        <meta property="og:site_name" content="Example News">
      </head></html>`)
    );

    expect(await processLinkPreviewQueue(bindings, LIMITS, "local.example")).toBe(1);
    expect(federation.safeFetch).toHaveBeenCalledTimes(1);

    const card = await db
      .prepare("SELECT * FROM preview_cards WHERE source_url = ?")
      .bind("https://news.example/story")
      .first<{ title: string; image_url: string; status: string }>();
    expect(card?.title).toBe("A story");
    expect(card?.image_url).toBe("https://cdn.example/cover.jpg");
    expect(card?.status).toBe("ready");

    const obj = await db
      .prepare("SELECT card_id, card_json FROM objects WHERE id = ?")
      .bind("https://remote.example/objects/1")
      .first<{ card_id: string; card_json: string }>();
    expect(obj?.card_id).toBeTruthy();
    const snapshot = JSON.parse(obj!.card_json) as Record<string, unknown>;
    expect(snapshot.title).toBe("A story");
    expect(snapshot.image).toBe("https://cdn.example/cover.jpg");
    // The serializer exposes the card exactly as posted (original URL).
    expect(snapshot.url).toBe("https://news.example/story");

    // ...and every status API response carries it, straight from the row.
    const object = await getObjectById(db, "https://remote.example/objects/1");
    const author = await getActorById(db, object!.actorId);
    const status = serializeStatus(object!, author!, "local.example");
    expect(status.card?.title).toBe("A story");
    expect(status.card?.provider_name).toBe("Example News");

    const queued = await db.prepare("SELECT COUNT(*) AS n FROM link_preview_queue").bind().first<{ n: number }>();
    expect(queued?.n).toBe(0);

    // The preview image goes through the media cache (same client/UA).
    const cached = await db
      .prepare("SELECT target_type FROM media_cache WHERE source_url = ?")
      .bind("https://cdn.example/cover.jpg")
      .first<{ target_type: string }>();
    expect(cached?.target_type).toBe("card");
  });

  it("notifies the caller when a card is attached so clients can be refreshed", async () => {
    await seedObject("https://remote.example/objects/1", '<a href="https://news.example/story">a</a>');
    await enqueueLinkPreview(db, "https://remote.example/objects/1");
    federation.safeFetch.mockResolvedValueOnce(okHtml('<meta property="og:title" content="Live">'));

    const attached: string[] = [];
    await processLinkPreviewQueue(bindings, LIMITS, "local.example", {
      onAttached: (objectId) => { attached.push(objectId); },
    });
    expect(attached).toEqual(["https://remote.example/objects/1"]);
  });

  it("reuses a fresh card for other statuses without hitting the origin again", async () => {
    await seedObject("https://remote.example/objects/1", '<a href="https://news.example/story">a</a>');
    await seedObject("https://remote.example/objects/2", '<a href="https://news.example/story">b</a>');
    await enqueueLinkPreview(db, "https://remote.example/objects/1");
    await enqueueLinkPreview(db, "https://remote.example/objects/2");
    federation.safeFetch.mockResolvedValueOnce(okHtml('<meta property="og:title" content="Shared">'));

    expect(await processLinkPreviewQueue(bindings, LIMITS, "local.example")).toBe(2);
    expect(federation.safeFetch).toHaveBeenCalledTimes(1);
    const linked = await db
      .prepare("SELECT COUNT(*) AS n FROM objects WHERE card_id IS NOT NULL")
      .bind()
      .first<{ n: number }>();
    expect(linked?.n).toBe(2);
  });

  it("skips statuses with media or a quote (Mastodon behaviour)", async () => {
    await seedObject("https://remote.example/objects/1", '<a href="https://news.example/story">a</a>');
    await seedObject("https://remote.example/objects/2", '<a href="https://news.example/story">b</a>', "https://remote.example/objects/1");
    await db
      .prepare("INSERT INTO attachments (id, object_id, type, url) VALUES ('att1', 'https://remote.example/objects/1', 'image', 'https://cdn.example/a.png')")
      .bind()
      .run();
    await enqueueLinkPreview(db, "https://remote.example/objects/1");
    await enqueueLinkPreview(db, "https://remote.example/objects/2");

    expect(await processLinkPreviewQueue(bindings, LIMITS, "local.example")).toBe(0);
    expect(federation.safeFetch).not.toHaveBeenCalled();
    const queued = await db.prepare("SELECT COUNT(*) AS n FROM link_preview_queue").bind().first<{ n: number }>();
    expect(queued?.n).toBe(0);
  });

  it("negative caches a URL that produces no preview metadata", async () => {
    await seedObject("https://remote.example/objects/1", '<a href="https://news.example/empty">a</a>');
    await seedObject("https://remote.example/objects/2", '<a href="https://news.example/empty">b</a>');
    await enqueueLinkPreview(db, "https://remote.example/objects/1");
    await enqueueLinkPreview(db, "https://remote.example/objects/2");
    federation.safeFetch.mockResolvedValue(okHtml("<html><head></head><body>nothing</body></html>"));

    expect(await processLinkPreviewQueue(bindings, LIMITS, "local.example")).toBe(0);
    expect(federation.safeFetch).toHaveBeenCalledTimes(1);
    const failed = await db
      .prepare("SELECT status FROM preview_cards WHERE source_url = ?")
      .bind("https://news.example/empty")
      .first<{ status: string }>();
    expect(failed?.status).toBe("failed");
  });

  it("prefers oEmbed over OpenGraph and sanitizes the video embed", async () => {
    await seedObject("https://remote.example/objects/1", '<a href="https://video.example/watch/1">video</a>');
    await enqueueLinkPreview(db, "https://remote.example/objects/1");
    federation.safeFetch
      .mockResolvedValueOnce(
        okHtml(`<html><head>
          <meta property="og:title" content="OG fallback">
          <link rel="alternate" type="application/json+oembed" href="https://video.example/oembed?url=https%3A%2F%2Fvideo.example%2Fwatch%2F1">
        </head></html>`)
      )
      .mockResolvedValueOnce(
        okJson({
          version: "1.0",
          type: "video",
          title: "oEmbed title",
          html: '<iframe src="https://player.example/embed/1" width="480" height="270"></iframe><script>evil()</script>',
          width: 480,
          height: 270,
          thumbnail_url: "https://video.example/thumb.jpg",
          provider_name: "Video Co",
        })
      );

    expect(await processLinkPreviewQueue(bindings, LIMITS, "local.example")).toBe(1);
    const card = await db
      .prepare("SELECT type, title, html, width, image_url FROM preview_cards WHERE source_url = ?")
      .bind("https://video.example/watch/1")
      .first<{ type: string; title: string; html: string; width: number; image_url: string }>();
    expect(card?.type).toBe("video");
    expect(card?.title).toBe("oEmbed title");
    expect(card?.width).toBe(480);
    expect(card?.image_url).toBe("https://video.example/thumb.jpg");
    expect(card?.html).toContain('src="https://player.example/embed/1"');
    expect(card?.html).not.toContain("<script");
  });

  it("serves the preview image from R2 once the media cache processes it", async () => {
    await seedObject("https://remote.example/objects/1", '<a href="https://news.example/story">a</a>');
    await enqueueLinkPreview(db, "https://remote.example/objects/1");
    federation.safeFetch.mockResolvedValueOnce(
      okHtml('<meta property="og:title" content="Cached"><meta property="og:image" content="https://cdn.example/cover.jpg">')
    );
    await processLinkPreviewQueue(bindings, LIMITS, "local.example");

    federation.safeFetch.mockResolvedValueOnce(okResponse(new Uint8Array([1, 2, 3]), "image/jpeg"));
    const mediaBindings = { DB: db, R2: r2 as never, KV: kv as never };
    expect(await processMediaCacheQueue(mediaBindings, MEDIA_LIMITS, BASE)).toBe(1);

    const card = await db
      .prepare("SELECT image_cache_url FROM preview_cards WHERE source_url = ?")
      .bind("https://news.example/story")
      .first<{ image_cache_url: string }>();
    expect(card?.image_cache_url).toContain("/api/media/cache/media/");
    const obj = await db
      .prepare("SELECT card_json FROM objects WHERE id = ?")
      .bind("https://remote.example/objects/1")
      .first<{ card_json: string }>();
    expect((JSON.parse(obj!.card_json) as { image: string }).image).toBe(card?.image_cache_url);
  });
});

describe("card serializer", () => {
  it("parses a snapshot and rejects malformed payloads", () => {
    expect(parsePreviewCard(null)).toBeNull();
    expect(parsePreviewCard("{not json")).toBeNull();
    expect(parsePreviewCard("{}")).toBeNull();
    const card = parsePreviewCard(
      JSON.stringify({
        url: "https://news.example/story",
        title: "T",
        description: "D",
        type: "video",
        image: "https://cdn.example/cover.jpg",
        html: "<iframe src=\"https://player.example/1\"></iframe>",
        width: 480,
        height: 270,
        language: "en",
      })
    );
    expect(card?.type).toBe("video");
    expect(card?.image).toBe("https://cdn.example/cover.jpg");
    expect(card?.width).toBe(480);
  });
});
