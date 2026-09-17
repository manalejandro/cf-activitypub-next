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

import {
  backfillMediaCache,
  enforceMediaCacheBudget,
  maintainMediaCache,
  mediaCacheLimitsFrom,
  processMediaCacheQueue,
  purgeMediaCache,
  type MediaCacheBindings,
  type MediaCacheLimits,
} from "@/lib/media/remote-cache";
import { enqueueMediaCache, getMediaCacheStats } from "@/lib/db";
import { resolveLimits } from "@/lib/constants";

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
  async get(key: string) {
    const value = this.store.get(key);
    return value ? { body: value } : null;
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

const LIMITS: MediaCacheLimits = {
  enabled: true,
  days: 7,
  profileDays: 30,
  maxBytes: 10 * 1024 * 1024,
  maxObjectBytes: 1024 * 1024,
  fetchBatch: 5,
  minEntries: 0,
  userAgents: ["bot-agent", "browser-agent"],
};

function okResponse(body: Uint8Array, contentType: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: undefined,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function statusResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

const SRC = "https://remote.example/media/a.png";
const ATTACH = "att-1";

let db: D1Database;
let r2: FakeR2;
let kv: FakeKV;
let bindings: MediaCacheBindings;

beforeEach(async () => {
  federation.safeFetch.mockReset();
  federation.validateOutboundUrl.mockReturnValue({ valid: true });
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
  r2 = new FakeR2();
  kv = new FakeKV();
  bindings = { DB: db, R2: r2 as never, KV: kv };

  await db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
     VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
  ).bind().run();
  await db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, avatar_url)
     VALUES ('https://remote.example/users/fan', 'fan', 'remote.example', 'k', NULL, 0, 'https://remote.example/avatar.png')`
  ).bind().run();
  await db.prepare(
    `INSERT INTO objects (id, type, actor_id, visibility, is_local)
     VALUES ('https://remote.example/objects/1', 'Note', 'https://remote.example/users/fan', 'public', 0)`
  ).bind().run();
  await db.prepare(
    `INSERT INTO attachments (id, object_id, type, url, remote_url, mime_type)
     VALUES (?, 'https://remote.example/objects/1', 'image', ?, ?, NULL)`
  ).bind(ATTACH, SRC, SRC).run();
});

describe("remote media cache", () => {
  it("caches a queued attachment using the first accepted user agent", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    const image = new Uint8Array([1, 2, 3, 4]);
    federation.safeFetch
      .mockResolvedValueOnce(statusResponse(403))
      .mockResolvedValueOnce(okResponse(image, "image/png"));

    const cached = await processMediaCacheQueue(bindings, LIMITS, "https://local.example");
    expect(cached).toBe(1);
    expect(federation.safeFetch).toHaveBeenCalledTimes(2);
    const secondHeaders = federation.safeFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders["User-Agent"]).toBe("browser-agent");

    const stats = await getMediaCacheStats(db);
    expect(stats.ready).toBe(1);
    expect(stats.bytes).toBe(image.byteLength);
    expect(r2.store.size).toBe(1);
    const [key] = [...r2.store.keys()];
    expect(key).toMatch(/^cache\/media\/[0-9a-f]{64}\.png$/);

    // The attachment now serves the cached copy; remote_url keeps the origin.
    const att = await db.prepare("SELECT url, remote_url, file_size FROM attachments WHERE id = ?").bind(ATTACH).first<{ url: string; remote_url: string; file_size: number }>();
    expect(att?.url).toBe(`https://local.example/api/media/${key}`);
    expect(att?.remote_url).toBe(SRC);
    expect(att?.file_size).toBe(image.byteLength);
  });

  it("caches a remote avatar and exposes the cached URL to serializers", async () => {
    await enqueueMediaCache(db, "https://remote.example/avatar.png", "avatar", "https://remote.example/users/fan");
    federation.safeFetch.mockResolvedValue(okResponse(new Uint8Array([9]), "image/jpeg"));

    expect(await processMediaCacheQueue(bindings, LIMITS, "https://local.example")).toBe(1);
    const actor = await db
      .prepare("SELECT avatar_url, avatar_cache_url FROM actors WHERE id = 'https://remote.example/users/fan'")
      .bind()
      .first<{ avatar_url: string; avatar_cache_url: string }>();
    expect(actor?.avatar_url).toBe("https://remote.example/avatar.png");
    expect(actor?.avatar_cache_url).toContain("/api/media/cache/media/");
  });

  it("gives up on 404 without storing anything", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    federation.safeFetch.mockResolvedValue(statusResponse(404));

    expect(await processMediaCacheQueue(bindings, LIMITS, "https://local.example")).toBe(0);
    expect(r2.store.size).toBe(0);
    const row = await db.prepare("SELECT status, attempts FROM media_cache WHERE source_url = ?").bind(SRC).first<{ status: string; attempts: number }>();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);
  });

  it("rejects non-media content types and oversized bodies", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    federation.safeFetch.mockResolvedValue(okResponse(new TextEncoder().encode("<html></html>") as Uint8Array, "text/html"));
    expect(await processMediaCacheQueue(bindings, LIMITS, "https://local.example")).toBe(0);
    expect(r2.store.size).toBe(0);

    await db.prepare("UPDATE media_cache SET status='pending', next_attempt_at=datetime('now') WHERE source_url = ?").bind(SRC).run();
    const huge = new Uint8Array(2 * 1024 * 1024);
    federation.safeFetch.mockReset();
    federation.safeFetch.mockResolvedValue(okResponse(huge, "image/png"));
    expect(await processMediaCacheQueue(bindings, LIMITS, "https://local.example")).toBe(0);
    expect(r2.store.size).toBe(0);
  });

  it("ignores queued rows for non-HTTPS URLs", async () => {
    await enqueueMediaCache(db, "http://remote.example/a.png", "attachment", ATTACH);
    expect(await processMediaCacheQueue(bindings, LIMITS, "https://local.example")).toBe(0);
    expect(federation.safeFetch).not.toHaveBeenCalled();
  });

  it("expires attachments by days and profile media by profile days", async () => {
    // The local account follows `fan`: their profile media must be kept.
    await db.prepare(
      "INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', 'https://local.example/users/me', 'https://remote.example/users/fan', 'accepted')"
    ).bind().run();
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    await enqueueMediaCache(db, "https://remote.example/old-avatar.png", "avatar", "https://remote.example/users/fan");

    // Make everything ready and old.
    await db.prepare(
      `UPDATE media_cache SET status='ready', r2_key = 'cache/media/' || id || '.png', size = 100,
         fetched_at = datetime('now', '-40 days')`
    ).bind().run();

    const result = await maintainMediaCache(bindings, LIMITS);
    expect(result.expired).toBe(1);
    const remaining = await db.prepare("SELECT source_url FROM media_cache WHERE status = 'ready' ORDER BY source_url").bind().all<{ source_url: string }>();
    // The attachment aged out at 7 days; the followed account's avatar is kept
    // even though it is older than the 30-day profile window.
    expect(remaining.results.map((r) => r.source_url)).toEqual(["https://remote.example/old-avatar.png"]);
  });

  it("evicts the oldest entries when the byte budget is exceeded", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    await enqueueMediaCache(db, "https://remote.example/other.png", "attachment", ATTACH);
    await db.prepare("UPDATE media_cache SET status='ready', r2_key = 'cache/media/' || id || '.png', size = ?, fetched_at = datetime('now', ?)")
      .bind(600_000, "-2 days").run();
    await db.prepare("UPDATE media_cache SET fetched_at = datetime('now', '-1 day') WHERE source_url = ?").bind("https://remote.example/other.png").run();

    const result = await maintainMediaCache(bindings, { ...LIMITS, maxBytes: 700_000 });
    expect(result.evicted).toBe(1);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM media_cache WHERE status='ready'").bind().first<{ n: number }>();
    expect(left?.n).toBe(1);
  });

  it("honors the configured byte budget when handed the raw instance limits", async () => {
    // Production regression: the cron passed resolveLimits() (whose fields are
    // mediaCache*) straight in. The unrecognized names fell back to the 10 GiB
    // default, so MEDIA_CACHE_MAX_BYTES was silently ignored and the cache
    // hovered at 10 GiB instead of draining to the configured limit.
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    await enqueueMediaCache(db, "https://remote.example/other.png", "attachment", ATTACH);
    await db.prepare("UPDATE media_cache SET status='ready', r2_key = 'cache/media/' || id || '.png', size = ?, fetched_at = datetime('now', ?)")
      .bind(600_000, "-2 days").run();
    await db.prepare("UPDATE media_cache SET fetched_at = datetime('now', '-1 day') WHERE source_url = ?")
      .bind("https://remote.example/other.png").run();

    const instanceLimits = resolveLimits({ MEDIA_CACHE_MAX_BYTES: "700000", MEDIA_CACHE_MIN_ENTRIES: "0" });
    const result = await maintainMediaCache(bindings, instanceLimits);
    expect(result.evicted).toBe(1);
    expect(result.overBudget).toBe(false);
    expect((await getMediaCacheStats(db)).bytes).toBeLessThanOrEqual(700_000);
  });

  it("maps the prefixed instance limits to the cache limit names", () => {
    const limits = mediaCacheLimitsFrom(resolveLimits({ MEDIA_CACHE_MAX_BYTES: "12345", MEDIA_CACHE_DAYS: "3" }));
    expect(limits.maxBytes).toBe(12345);
    expect(limits.days).toBe(3);
  });

  it("enforceMediaCacheBudget drains a lowered limit and reports what it did", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    await enqueueMediaCache(db, "https://remote.example/other.png", "attachment", ATTACH);
    await db.prepare("UPDATE media_cache SET status='ready', r2_key = 'cache/media/' || id || '.png', size = ?, fetched_at = datetime('now', ?)")
      .bind(600_000, "-2 days").run();
    await db.prepare("UPDATE media_cache SET fetched_at = datetime('now', '-1 day') WHERE source_url = ?")
      .bind("https://remote.example/other.png").run();

    const result = await enforceMediaCacheBudget(
      bindings,
      resolveLimits({ MEDIA_CACHE_MAX_BYTES: "700000", MEDIA_CACHE_MIN_ENTRIES: "0" }),
      5_000
    );
    expect(result.evicted).toBe(1);
    expect(result.bytesBefore).toBe(1_200_000);
    expect(result.bytesAfter).toBeLessThanOrEqual(700_000);
    expect(result.bytesAfter).toBe((await getMediaCacheStats(db)).bytes);
  });

  it("backfills existing attachments and avatars, then serves them from the cache", async () => {
    // The local account follows the remote actor so its profile is a priority.
    await db.prepare(
      "INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', 'https://local.example/users/me', 'https://remote.example/users/fan', 'accepted')"
    ).bind().run();
    // Attachment ingested before the cache existed: no media_cache row.
    const before = await db.prepare("SELECT COUNT(*) AS n FROM media_cache").bind().first<{ n: number }>();
    expect(before?.n).toBe(0);

    federation.safeFetch.mockResolvedValue(okResponse(new Uint8Array([7, 7]), "image/webp"));
    const queued = await backfillMediaCache(bindings, LIMITS);
    expect(queued).toBe(2); // attachment + avatar

    // The backfill queues behind fresh ingests (30 min); simulate time passing.
    await db.prepare("UPDATE media_cache SET next_attempt_at = datetime('now', '-1 second')").bind().run();

    const cachedCount = await processMediaCacheQueue(bindings, LIMITS, "https://local.example");
    expect(cachedCount).toBe(2);

    const att = await db.prepare("SELECT url, remote_url FROM attachments WHERE id = ?").bind(ATTACH).first<{ url: string; remote_url: string }>();
    expect(att?.url).toContain("/api/media/cache/media/");
    expect(att?.remote_url).toBe(SRC);

    const actor = await db
      .prepare("SELECT avatar_cache_url FROM actors WHERE id = 'https://remote.example/users/fan'")
      .bind()
      .first<{ avatar_cache_url: string }>();
    expect(actor?.avatar_cache_url).toContain("/api/media/cache/media/");
  });

  it("lets a fresh ingest jump the backfill queue", async () => {
    // Backfill queued the URL 30 minutes into the future…
    await enqueueMediaCache(db, SRC, "attachment", ATTACH, 1_800);
    let due = await db
      .prepare("SELECT COUNT(*) AS n FROM media_cache WHERE next_attempt_at <= datetime('now')")
      .bind()
      .first<{ n: number }>();
    expect(due?.n).toBe(0);

    // …a fresh ingest of the same URL pulls it to "now".
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    due = await db
      .prepare("SELECT COUNT(*) AS n FROM media_cache WHERE next_attempt_at <= datetime('now')")
      .bind()
      .first<{ n: number }>();
    expect(due?.n).toBe(1);

    federation.safeFetch.mockResolvedValue(okResponse(new Uint8Array([3]), "image/png"));
    expect(await processMediaCacheQueue(bindings, LIMITS, "https://local.example")).toBe(1);
  });

  it("treats a partial limits object as enabled with defaults (never wipes the queue)", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    federation.safeFetch.mockResolvedValue(okResponse(new Uint8Array([5]), "image/png"));

    // A stale/rolled-back build may pass an empty limits object: this must mean
    // "enabled with defaults", not "disabled, delete everything".
    const cached = await processMediaCacheQueue(bindings, {} as MediaCacheLimits, "https://local.example");
    expect(cached).toBe(1);
    expect((await getMediaCacheStats(db)).ready).toBe(1);
  });

  it("keeps queued rows when the cache is explicitly disabled", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    const cached = await processMediaCacheQueue(bindings, { ...LIMITS, enabled: false }, "https://local.example");
    expect(cached).toBe(0);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM media_cache").bind().first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("evicts FIFO and never shrinks below the floor (keeps the newest)", async () => {
    // Three ready entries, oldest first, over a tiny byte budget.
    for (const [url, ageDays] of [
      ["https://remote.example/old.png", 3],
      ["https://remote.example/mid.png", 2],
      ["https://remote.example/new.png", 1],
    ] as const) {
      await enqueueMediaCache(db, url, "attachment", ATTACH);
      await db.prepare(
        "UPDATE media_cache SET status='ready', r2_key = 'cache/media/' || id || '.png', size = 600000, fetched_at = datetime('now', ?) WHERE source_url = ?"
      ).bind(`-${ageDays} days`, url).run();
    }

    // Budget 700 KB but keep at least 2 entries: only the OLDEST is evicted.
    const result = await maintainMediaCache(bindings, { ...LIMITS, maxBytes: 700_000, minEntries: 2 });
    expect(result.evicted).toBe(1);
    const left = await db
      .prepare("SELECT source_url FROM media_cache WHERE status='ready' ORDER BY fetched_at ASC")
      .bind()
      .all<{ source_url: string }>();
    expect(left.results.map((r) => r.source_url)).toEqual([
      "https://remote.example/mid.png",
      "https://remote.example/new.png",
    ]);
  });

  it("drains a large overage down to the budget in one tick (FIFO, newest survives)", async () => {
    for (let i = 0; i < 5; i++) {
      const url = `https://remote.example/p${i}.png`;
      await enqueueMediaCache(db, url, "attachment", ATTACH);
      await db.prepare(
        "UPDATE media_cache SET status='ready', r2_key = 'cache/media/' || id || '.png', size = 600000, fetched_at = datetime('now', ?) WHERE source_url = ?"
      ).bind(`-${5 - i} days`, url).run();
    }

    // 3 MB cached against a 600 KB budget: eviction is byte-bounded, so it
    // deletes the four oldest entries in this tick instead of 50 rows/tick.
    const result = await maintainMediaCache(bindings, { ...LIMITS, maxBytes: 600_000, minEntries: 1 });
    expect(result.evicted).toBe(4);
    const left = await db.prepare("SELECT source_url FROM media_cache WHERE status='ready'").bind().all<{ source_url: string }>();
    expect(left.results.map((r) => r.source_url)).toEqual(["https://remote.example/p4.png"]);
  });

  it("does not fetch while the cache is over the byte budget", async () => {
    // One huge ready entry pushes the cache over the limit…
    await enqueueMediaCache(db, "https://remote.example/huge.png", "attachment", ATTACH);
    await db.prepare(
      "UPDATE media_cache SET status='ready', r2_key = 'cache/media/huge.png', size = 5_000_000, fetched_at = datetime('now') WHERE source_url = ?"
    ).bind("https://remote.example/huge.png").run();
    // …and a fresh ingest is queued meanwhile.
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    federation.safeFetch.mockClear();

    const limits = { ...LIMITS, maxBytes: 1_000_000 };
    expect(await processMediaCacheQueue(bindings, limits, "https://local.example")).toBe(0);
    expect(await backfillMediaCache(bindings, limits)).toBe(0);
    expect(federation.safeFetch).not.toHaveBeenCalled();
    const row = await db.prepare("SELECT status FROM media_cache WHERE source_url = ?").bind(SRC).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("never wipes the cache through age-based expiry alone", async () => {
    for (let i = 0; i < 4; i++) {
      const url = `https://remote.example/x${i}.png`;
      await enqueueMediaCache(db, url, "attachment", ATTACH);
      await db.prepare(
        "UPDATE media_cache SET status='ready', r2_key = 'cache/media/' || id || '.png', size = 10, fetched_at = datetime('now', ?) WHERE source_url = ?"
      ).bind(`-${40 + i} days`, url).run();
    }
    // The whole cache is expired, but a floor of 3 keeps the newest entries.
    const result = await maintainMediaCache(bindings, { ...LIMITS, minEntries: 3 });
    expect(result.expired).toBe(1);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM media_cache WHERE status='ready'").bind().first<{ n: number }>();
    expect(left?.n).toBe(3);
  });

  it("rewrites every attachment that shares the cached source URL", async () => {
    // A second post (repost/quote) referencing the exact same file.
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, visibility, is_local)
       VALUES ('https://remote.example/objects/2', 'Note', 'https://remote.example/users/fan', 'public', 0)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO attachments (id, object_id, type, url, remote_url, mime_type)
       VALUES ('att-2', 'https://remote.example/objects/2', 'image', ?, ?, NULL)`
    ).bind(SRC, SRC).run();

    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    federation.safeFetch.mockResolvedValue(okResponse(new Uint8Array([1, 2]), "image/png"));
    expect(await processMediaCacheQueue(bindings, LIMITS, "https://local.example")).toBe(1);

    const rows = await db
      .prepare("SELECT id, url FROM attachments WHERE id IN ('att-1','att-2') ORDER BY id")
      .bind()
      .all<{ id: string; url: string }>();
    expect(rows.results.map((r) => r.url.startsWith("https://local.example/api/media/cache/media/"))).toEqual([true, true]);
  });

  it("serves an already-cached URL immediately on a new reference", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    federation.safeFetch.mockResolvedValue(okResponse(new Uint8Array([1]), "image/png"));
    await processMediaCacheQueue(bindings, LIMITS, "https://local.example");

    // New post referencing the same file: enqueue must rewrite it on the spot.
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, visibility, is_local)
       VALUES ('https://remote.example/objects/3', 'Note', 'https://remote.example/users/fan', 'public', 0)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO attachments (id, object_id, type, url, remote_url, mime_type)
       VALUES ('att-3', 'https://remote.example/objects/3', 'image', ?, ?, NULL)`
    ).bind(SRC, SRC).run();
    federation.safeFetch.mockClear();

    await enqueueMediaCache(db, SRC, "attachment", "att-3");
    expect(federation.safeFetch).not.toHaveBeenCalled();
    const row = await db.prepare("SELECT url FROM attachments WHERE id = 'att-3'").bind().first<{ url: string }>();
    expect(row?.url).toContain("/api/media/cache/media/");
  });

  it("purges every cached object and row", async () => {
    await enqueueMediaCache(db, SRC, "attachment", ATTACH);
    federation.safeFetch.mockResolvedValue(okResponse(new Uint8Array([1]), "image/png"));
    await processMediaCacheQueue(bindings, LIMITS, "https://local.example");
    expect(r2.store.size).toBe(1);

    expect(await purgeMediaCache(bindings)).toBe(1);
    expect(r2.store.size).toBe(0);
    expect((await getMediaCacheStats(db)).ready).toBe(0);
  });
});
