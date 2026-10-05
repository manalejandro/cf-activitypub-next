import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

import {
  clearMediaPending,
  enqueueMediaCache,
  getHomeTimeline,
  getPublicTimeline,
  markObjectMediaPending,
  releaseMediaPendingObjects,
  releaseStaleMediaPendingObjects,
} from "@/lib/db";

const REMOTE_ACTOR = "https://remote.example/users/author";
const REMOTE_OBJECT = "https://remote.example/objects/1";
const SRC = "https://remote.example/media/a.png";

const db = env.DB;

async function mediaPending(objectId: string): Promise<number> {
  const row = await db
    .prepare("SELECT media_pending FROM objects WHERE id = ?")
    .bind(objectId)
    .first<{ media_pending: number }>();
  return Number(row?.media_pending ?? 0);
}

beforeEach(async () => {
  await resetTestDatabase();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, 'author', 'remote.example', 'k', NULL, 0)`
    )
    .bind(REMOTE_ACTOR)
    .run();
});

async function seedObject(actorId = REMOTE_ACTOR, id = REMOTE_OBJECT): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES (?, 'Note', ?, '<p>hi</p>', 'public', 0, '{}')`
    )
    .bind(id, actorId)
    .run();
}

describe("media-pending gating", () => {
  it("holds a remote status until its attachments are cached, then releases it", async () => {
    await seedObject();
    await db
      .prepare(
        `INSERT INTO attachments (id, object_id, type, url, remote_url)
         VALUES ('att-1', ?, 'image', ?, ?)`
      )
      .bind(REMOTE_OBJECT, SRC, SRC)
      .run();
    await enqueueMediaCache(db, SRC, "attachment", "att-1");
    await markObjectMediaPending(db, REMOTE_OBJECT);
    expect(await mediaPending(REMOTE_OBJECT)).toBe(1);

    // Hidden from the public timeline while pending.
    expect((await getPublicTimeline(db, 20)).map((o) => o.id)).toEqual([]);

    await db
      .prepare("UPDATE media_cache SET status = 'ready', r2_key = 'cache/media/x.png', cached_url = 'https://local.example/api/media/cache/media/x.png', fetched_at = datetime('now') WHERE source_url = ?")
      .bind(SRC)
      .run();
    expect(await releaseMediaPendingObjects(db, 50)).toEqual([REMOTE_OBJECT]);
    expect(await mediaPending(REMOTE_OBJECT)).toBe(0);
    expect((await getPublicTimeline(db, 20)).map((o) => o.id)).toEqual([REMOTE_OBJECT]);
  });

  it("holds a status whose author avatar is not cached yet", async () => {
    const avatar = "https://remote.example/avatar.png";
    await db.prepare("UPDATE actors SET avatar_url = ? WHERE id = ?").bind(avatar, REMOTE_ACTOR).run();
    await enqueueMediaCache(db, avatar, "avatar", REMOTE_ACTOR);
    await seedObject();
    await markObjectMediaPending(db, REMOTE_OBJECT);
    expect(await mediaPending(REMOTE_OBJECT)).toBe(1);

    await db
      .prepare("UPDATE media_cache SET status = 'ready', r2_key = 'cache/media/av.png', cached_url = 'https://local.example/api/media/cache/media/av.png', fetched_at = datetime('now') WHERE source_url = ?")
      .bind(avatar)
      .run();
    await db.prepare("UPDATE actors SET avatar_cache_url = 'https://local.example/api/media/cache/media/av.png' WHERE id = ?")
      .bind(REMOTE_ACTOR).run();
    expect(await releaseMediaPendingObjects(db, 50)).toEqual([REMOTE_OBJECT]);
  });

  it("releases statuses whose media caching failed permanently", async () => {
    await seedObject();
    await db
      .prepare(`INSERT INTO attachments (id, object_id, type, url, remote_url) VALUES ('att-1', ?, 'image', ?, ?)`)
      .bind(REMOTE_OBJECT, SRC, SRC).run();
    await enqueueMediaCache(db, SRC, "attachment", "att-1");
    await markObjectMediaPending(db, REMOTE_OBJECT);
    await db
      .prepare("UPDATE media_cache SET status = 'failed', attempts = 3, next_attempt_at = datetime('now', '+7 days') WHERE source_url = ?")
      .bind(SRC).run();

    expect(await releaseMediaPendingObjects(db, 50)).toEqual([REMOTE_OBJECT]);
    expect(await mediaPending(REMOTE_OBJECT)).toBe(0);
  });

  it("never holds local statuses (their media is already on R2)", async () => {
    const local = "https://local.example/users/me";
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
         VALUES (?, 'me', 'local.example', 'k', 'p', 1)`
      )
      .bind(local).run();
    await seedObject(local, "https://local.example/objects/1");
    await db
      .prepare(`INSERT INTO attachments (id, object_id, type, url, remote_url) VALUES ('att-l', 'https://local.example/objects/1', 'image', 'https://local.example/media/a.png', NULL)`)
      .bind().run();

    await markObjectMediaPending(db, "https://local.example/objects/1");
    expect(await mediaPending("https://local.example/objects/1")).toBe(0);
  });

  it("filters held statuses out of the home timeline", async () => {
    const local = "https://local.example/users/me";
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
         VALUES (?, 'me', 'local.example', 'k', 'p', 1)`
      )
      .bind(local).run();
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
      .bind(local, REMOTE_ACTOR).run();
    await seedObject();
    await db
      .prepare(`INSERT INTO attachments (id, object_id, type, url, remote_url) VALUES ('att-1', ?, 'image', ?, ?)`)
      .bind(REMOTE_OBJECT, SRC, SRC).run();
    await enqueueMediaCache(db, SRC, "attachment", "att-1");
    await markObjectMediaPending(db, REMOTE_OBJECT);

    expect((await getHomeTimeline(db, local, 20)).map((entry) => entry.object.id)).toEqual([]);
  });

  it("releases stale holds so a degraded cache cannot hide content forever", async () => {
    await seedObject();
    await db
      .prepare(`INSERT INTO attachments (id, object_id, type, url, remote_url) VALUES ('att-1', ?, 'image', ?, ?)`)
      .bind(REMOTE_OBJECT, SRC, SRC).run();
    await enqueueMediaCache(db, SRC, "attachment", "att-1");
    await markObjectMediaPending(db, REMOTE_OBJECT);
    // Freshly published: still held.
    expect(await releaseStaleMediaPendingObjects(db, 30, 10)).toEqual([]);

    // Production rows store `published` as ISO-8601 (JS toISOString), not in
    // SQLite's datetime format: the same-day comparison used to fail ('T' > ' ').
    await db.prepare("UPDATE objects SET published = ? WHERE id = ?")
      .bind(new Date(Date.now() - 2 * 3_600_000).toISOString(), REMOTE_OBJECT).run();
    expect(await releaseStaleMediaPendingObjects(db, 30, 10)).toEqual([REMOTE_OBJECT]);
    expect(await mediaPending(REMOTE_OBJECT)).toBe(0);
  });

  it("clears every flag when the media cache is disabled", async () => {
    await seedObject();
    await seedObject(REMOTE_ACTOR, "https://remote.example/objects/2");
    await db
      .prepare(`INSERT INTO attachments (id, object_id, type, url, remote_url) VALUES ('att-1', ?, 'image', ?, ?)`)
      .bind(REMOTE_OBJECT, SRC, SRC).run();
    await enqueueMediaCache(db, SRC, "attachment", "att-1");
    await db
      .prepare(`INSERT INTO attachments (id, object_id, type, url, remote_url) VALUES ('att-2', 'https://remote.example/objects/2', 'image', ?, ?)`)
      .bind("https://remote.example/media/b.png", "https://remote.example/media/b.png").run();
    await enqueueMediaCache(db, "https://remote.example/media/b.png", "attachment", "att-2");
    await markObjectMediaPending(db, REMOTE_OBJECT);
    await markObjectMediaPending(db, "https://remote.example/objects/2");
    expect(await mediaPending("https://remote.example/objects/2")).toBe(1);

    expect(await clearMediaPending(db, 100)).toBe(2);
    expect(await mediaPending(REMOTE_OBJECT)).toBe(0);
    expect(await mediaPending("https://remote.example/objects/2")).toBe(0);
  });
});
