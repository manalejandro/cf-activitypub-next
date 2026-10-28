import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

import {
  DEFAULT_STORAGE_RETENTION,
  countIsStale,
  maintainStorageRetention,
  measureStoredPayload,
  nextFreedBytes,
  pruneFederatedHistory,
  readStorageRetentionStats,
  storageRetentionLimitsFrom,
} from "@/lib/storage-retention";
import { resolveLimits } from "@/lib/constants";
import { GET as getStorage, POST as postStorage } from "@/app/api/v1/admin/storage/route";

const db = env.DB;
const REMOTE = "https://remote.example/users/alice";
const LOCAL = "https://local.example/users/bob";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const OLD = "2024-01-01T00:00:00.000Z";
const RECENT = "2026-10-18T00:00:00.000Z";

async function seedActors(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified)
       VALUES (?, 'alice', 'remote.example', 'pub', NULL, 0, 1, 'alice@remote.example', 1),
              (?, 'bob', 'local.example', 'pub', 'priv', 1, 1, 'bob@local.example', 1)`
    )
    .bind(REMOTE, LOCAL)
    .run();
}

async function seedObject(opts: {
  id: string;
  actorId?: string;
  isLocal?: boolean;
  visibility?: string;
  published?: string;
  content?: string;
  inReplyTo?: string | null;
  raw?: string;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, raw, in_reply_to_id)
       VALUES (?, 'Note', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      opts.id,
      opts.actorId ?? REMOTE,
      opts.content ?? "contenido",
      opts.visibility ?? "public",
      opts.published ?? OLD,
      opts.published ?? OLD,
      opts.isLocal ? 1 : 0,
      opts.raw ?? JSON.stringify({ id: opts.id, type: "Note", content: "contenido" }),
      opts.inReplyTo ?? null
    )
    .run();
}

async function seedActivity(id: string, published: string, actorId = REMOTE): Promise<void> {
  // Production stores `activities.published` with `datetime('now')`'s
  // space-separated shape (a local processing stamp, not an AP instant). Seed
  // it the same way so retention's cutoff comparison is exercised against the
  // real shape (an ISO seed here hid a same-day over-prune).
  const dbShape = published.includes("T") ? published.replace("T", " ").slice(0, 19) : published;
  await db
    .prepare(
      `INSERT INTO activities (id, type, actor_id, raw, published, is_local, delivered)
       VALUES (?, 'Create', ?, ?, ?, 0, 1)`
    )
    .bind(id, actorId, JSON.stringify({ id, type: "Create" }), dbShape)
    .run();
}

/**
 * The bindings object is writable in the test runtime, but an operator running
 * the suite on a configured instance has DB_RETENTION_* in wrangler.toml: the
 * "disabled" path is exercised by clearing them and restoring them afterwards.
 */
function clearRetentionBindings(): () => void {
  const bindings = env as unknown as Record<string, string>;
  const saved = { days: bindings.DB_RETENTION_DAYS, max: bindings.DB_RETENTION_MAX_BYTES };
  delete bindings.DB_RETENTION_DAYS;
  delete bindings.DB_RETENTION_MAX_BYTES;
  return () => {
    if (saved.days === undefined) delete bindings.DB_RETENTION_DAYS;
    else bindings.DB_RETENTION_DAYS = saved.days;
    if (saved.max === undefined) delete bindings.DB_RETENTION_MAX_BYTES;
    else bindings.DB_RETENTION_MAX_BYTES = saved.max;
  };
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActors();
});

describe("storage retention", () => {
  it("deletes nothing while both knobs are 0 (the default), but keeps the size estimate", async () => {
    await seedObject({ id: "https://remote.example/objects/old" });
    await seedActivity("act-1", OLD);

    const run = await maintainStorageRetention(env, DEFAULT_STORAGE_RETENTION, NOW);

    expect(run.enabled).toBe(false);
    expect(run.objectsDeleted).toBe(0);
    expect(run.activitiesDeleted).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM objects")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM activities")).toBe(1);

    // The admin panel shows what the instance stores even with retention off,
    // so the bounded walk runs either way — and this pass completed.
    const stats = await readStorageRetentionStats(env);
    expect(stats.estimate.bytes).toBeGreaterThan(0);
    expect(stats.estimate.measuredAt).toBe(NOW.toISOString());
    expect(stats.estimate.measuring).toBe(false);
  });

  it("estimates the payload from probes, in a single pass", async () => {
    // The old cursor walk only published when both windows happened to be short
    // in the same call, so a busy instance never got an estimate; the sample is
    // atomic (one call) and reads a couple of probes per table.
    for (let i = 0; i < 3; i++) {
      await seedObject({ id: `https://remote.example/objects/w${i}`, raw: "a".repeat(900) });
    }
    for (let i = 0; i < 5; i++) {
      await seedActivity(`act-w${i}`, OLD, REMOTE);
      await db.prepare("UPDATE activities SET raw = ? WHERE id = ?").bind("b".repeat(900), `act-w${i}`).run();
    }

    const estimate = await measureStoredPayload(env, NOW);

    expect(estimate.completed).toBe(true);
    // 3 objects + 5 activities of ~900 bytes each, extrapolated from the probes.
    expect(estimate.bytes).toBeGreaterThan(7000);
    expect(estimate.bytes).toBeLessThan(7500);
    expect(estimate.rows).toBe(8);
    expect(estimate.measuring).toBe(false);
  });

  it("is off unless the operator sets an environment variable", () => {
    const defaults = resolveLimits({});
    expect(storageRetentionLimitsFrom(defaults)).toMatchObject({ days: 0, maxBytes: 0 });

    const configured = resolveLimits({ DB_RETENTION_DAYS: "90", DB_RETENTION_MAX_BYTES: "1024" });
    expect(storageRetentionLimitsFrom(configured)).toMatchObject({ days: 90, maxBytes: 1024 });
    // Garbage and negatives fall back to "keep everything".
    expect(resolveLimits({ DB_RETENTION_DAYS: "-5" }).dbRetentionDays).toBe(0);
  });

  it("deletes expired federated history and keeps everything else", async () => {
    await seedObject({ id: "https://remote.example/objects/old-public" });
    await seedObject({ id: "https://remote.example/objects/old-unlisted", visibility: "unlisted" });
    await seedObject({ id: "https://remote.example/objects/old-private", visibility: "private" });
    await seedObject({ id: "https://remote.example/objects/old-direct", visibility: "direct" });
    await seedObject({ id: "https://remote.example/objects/recent", published: RECENT });
    await seedObject({ id: "https://local.example/objects/mine", actorId: LOCAL, isLocal: true, published: OLD });
    await seedActivity("act-old", OLD);
    await seedActivity("act-recent", RECENT);
    // Boundary: same UTC day as the 30-day cutoff (2026-09-19T12:00:00Z) but a
    // later hour. The space shape must compare on the time, not on ' ' < 'T' —
    // with an ISO cutoff this was pruned a day early.
    await seedActivity("act-boundary", "2026-09-19T18:00:00.000Z");

    const run = await maintainStorageRetention(env, { ...DEFAULT_STORAGE_RETENTION, days: 30 }, NOW);

    expect(run.enabled).toBe(true);
    expect(run.objectsDeleted).toBe(2);
    expect(run.activitiesDeleted).toBe(1);
    const remaining = await db
      .prepare("SELECT id FROM objects ORDER BY id")
      .all<{ id: string }>();
    expect((remaining.results ?? []).map((r) => r.id)).toEqual([
      "https://local.example/objects/mine",
      "https://remote.example/objects/old-direct",
      "https://remote.example/objects/old-private",
      "https://remote.example/objects/recent",
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM activities")).toBe(2);
  });

  it("cascades the satellites of a pruned status and releases the parent's counters", async () => {
    await seedObject({ id: "https://remote.example/objects/parent", published: "2023-01-01T00:00:00.000Z" });
    await seedObject({
      id: "https://remote.example/objects/reply",
      inReplyTo: "https://remote.example/objects/parent",
      published: OLD,
    });
    await db
      .prepare(
        `UPDATE objects SET replies_count = 3, engagement = 5 WHERE id = 'https://remote.example/objects/parent'`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO attachments (id, object_id, type, url, remote_url) VALUES ('a1', 'https://remote.example/objects/reply', 'image', 'https://remote.example/media/1.jpg', 'https://remote.example/media/1.jpg')`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO notifications (id, type, account_id, target_account_id, object_id, created_at)
         VALUES ('n1', 'mention', ?, ?, 'https://remote.example/objects/reply', ?)`
      )
      .bind(REMOTE, LOCAL, OLD)
      .run();
    // The parent is protected by the local reply (its own date is older, so
    // without that rule it would go first) — which is what makes the counter
    // check meaningful: the reply is pruned while its parent survives.
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, in_reply_to_id)
         VALUES ('https://local.example/objects/reply-to-parent', 'Note', ?, 'mi respuesta', 'public', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 1, 'https://remote.example/objects/parent')`
      )
      .bind(LOCAL)
      .run();

    const pruned = await pruneFederatedHistory(env, { cutoff: "2025-06-01T00:00:00.000Z", limit: 50 });

    expect(pruned.objects).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM attachments")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM notifications")).toBe(0);
    const parent = await db
      .prepare("SELECT replies_count, engagement FROM objects WHERE id = 'https://remote.example/objects/parent'")
      .first<{ replies_count: number; engagement: number }>();
    expect(parent).toMatchObject({ replies_count: 2, engagement: 4 });
  });

  it("never prunes what a local account bookmarked or replied to", async () => {
    await seedObject({ id: "https://remote.example/objects/bookmarked" });
    await seedObject({ id: "https://remote.example/objects/replied" });
    await seedObject({ id: "https://remote.example/objects/free" });
    await db
      .prepare(
        `INSERT INTO bookmarks (id, actor_id, object_id, created_at) VALUES ('b1', ?, 'https://remote.example/objects/bookmarked', ?)`
      )
      .bind(LOCAL, OLD)
      .run();
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, in_reply_to_id)
         VALUES ('https://local.example/objects/mine-reply', 'Note', ?, 'respuesta', 'public', ?, ?, 1, 'https://remote.example/objects/replied')`
      )
      .bind(LOCAL, RECENT, RECENT)
      .run();

    const run = await maintainStorageRetention(env, { ...DEFAULT_STORAGE_RETENTION, days: 30 }, NOW);

    expect(run.objectsDeleted).toBe(1);
    const remaining = await db.prepare("SELECT id FROM objects ORDER BY id").all<{ id: string }>();
    expect((remaining.results ?? []).map((r) => r.id)).toContain("https://remote.example/objects/bookmarked");
    expect((remaining.results ?? []).map((r) => r.id)).toContain("https://remote.example/objects/replied");
  });

  it("lands within a few percent of the real payload on a skewed table", async () => {
    // 10k remote rows with a heavy tail (90% ~300 B, 9% ~4 KB, 1% ~40 KB): the
    // sample reads 8×1000 of them, so the estimate has to extrapolate across a
    // distribution where 40% of the bytes sit in 1% of the rows.
    await db
      .prepare(
        `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 10000)
         INSERT INTO objects (id, actor_id, content, visibility, url, published, raw, updated_at)
         SELECT 'https://remote.example/objects/bulk-' || i, ?,
                NULL, 'public', 'https://remote.example/objects/bulk-' || i,
                '2025-01-01T00:00:00.000Z',
                substr(hex(zeroblob(CASE WHEN i % 100 = 0 THEN 20000 WHEN i % 10 = 0 THEN 2000 ELSE 150 END)), 1,
                       CASE WHEN i % 100 = 0 THEN 40000 WHEN i % 10 = 0 THEN 4000 ELSE 300 END),
                '2025-01-01T00:00:00.000Z'
           FROM seq`
      )
      .bind(REMOTE)
      .run();

    const real = await count(
      `SELECT SUM(LENGTH(raw) + COALESCE(LENGTH(content), 0) + COALESCE(LENGTH(card_json), 0)) AS n
         FROM objects WHERE is_local = 0 AND visibility IN ('public', 'unlisted')`
    );
    const estimate = await measureStoredPayload(env, NOW);

    expect(estimate.rows).toBe(10_000);
    expect(Math.abs(estimate.bytes - real) / real).toBeLessThan(0.1);
  });

  it("samples the prunable payload and never counts local statuses", async () => {
    await seedObject({ id: "https://remote.example/objects/1", raw: "x".repeat(1000) });
    await seedObject({ id: "https://remote.example/objects/2", raw: "y".repeat(500) });
    await seedObject({ id: "https://local.example/objects/mine", actorId: LOCAL, isLocal: true, raw: "z".repeat(4000) });
    await seedActivity("act-1", OLD);

    const estimate = await measureStoredPayload(env, NOW);

    expect(estimate.completed).toBe(true);
    // Remote payload only: the local status is never counted — neither in the
    // sample's average (its 4 KB of `raw` would push the estimate past the
    // bound) nor in the exact row count.
    expect(estimate.bytes).toBeGreaterThan(1000);
    expect(estimate.bytes).toBeLessThan(2000);
    // Two statuses plus one activity (both tables are sampled).
    expect(estimate.rows).toBe(3);
    expect(estimate.measuredAt).toBe(NOW.toISOString());
  });

  it("prunes the oldest history while the database is over the byte budget", async () => {
    await seedObject({ id: "https://remote.example/objects/oldest", published: "2024-01-01T00:00:00.000Z", raw: "a".repeat(900) });
    await seedObject({ id: "https://remote.example/objects/middle", published: "2025-01-01T00:00:00.000Z", raw: "b".repeat(900) });
    await seedObject({ id: "https://remote.example/objects/newest", published: "2026-01-01T00:00:00.000Z", raw: "c".repeat(900) });

    const measured = await measureStoredPayload(env, NOW);
    expect(measured.bytes).toBeGreaterThan(2700);
    expect(measured.completed).toBe(true);

    // D1 reports the file size in every statement's meta (Miniflare does too),
    // so the budget is "the file must not keep growing": pruning `freed` bytes
    // of live data counts against it even though SQLite reuses the pages.
    const databaseBytes = measured.databaseBytes;
    expect(databaseBytes).toBeGreaterThan(0);
    const run = await maintainStorageRetention(
      env,
      { ...DEFAULT_STORAGE_RETENTION, maxBytes: (databaseBytes ?? 0) - 500, pruneBatch: 1 },
      NOW
    );

    expect(run.enabled).toBe(true);
    expect(run.objectsDeleted).toBeGreaterThanOrEqual(1);
    expect(run.bytesFreed).toBeGreaterThanOrEqual(500);
    expect(run.effectiveBytes).toBeLessThanOrEqual((databaseBytes ?? 0) - 500);
    const remaining = await db.prepare("SELECT id FROM objects ORDER BY published DESC").all<{ id: string }>();
    const ids = (remaining.results ?? []).map((r) => r.id);
    // The newest survives; the oldest is the first to go.
    expect(ids).toContain("https://remote.example/objects/newest");
    expect(ids).not.toContain("https://remote.example/objects/oldest");
  });

  it("budgets the file size, not the deletions, when SQLite reuses pages", () => {
    // A growing file consumed free pages: the credit shrinks with it.
    expect(nextFreedBytes({ size: 1000, freed: 300 }, 1100)).toBe(200);
    expect(nextFreedBytes({ size: 1000, freed: 300 }, 1400)).toBe(0);
    // A smaller file was compacted: the credit is gone with the pages.
    expect(nextFreedBytes({ size: 1000, freed: 300 }, 900)).toBe(0);
    // No size reported yet (first pass): nothing to fold in.
    expect(nextFreedBytes({ size: 0, freed: 0 }, 500)).toBe(0);
  });

  it("retakes the exact row counts at most once a day", async () => {
    // A count is an index-only walk of *every* prunable row (~400k entries,
    // 1.2 s per call on cf-ap), so between counts the stored figure is carried
    // over while the byte sample keeps its own cadence.
    expect(countIsStale(null, NOW)).toBe(true);
    expect(countIsStale("not-a-date", NOW)).toBe(true);
    expect(countIsStale(new Date(NOW.getTime() - 23 * 3_600_000).toISOString(), NOW)).toBe(false);
    expect(countIsStale(new Date(NOW.getTime() - 25 * 3_600_000).toISOString(), NOW)).toBe(true);

    await seedObject({ id: "https://remote.example/objects/1" });
    expect((await measureStoredPayload(env, NOW)).rows).toBe(1);

    await seedObject({ id: "https://remote.example/objects/2" });
    expect((await measureStoredPayload(env, new Date(NOW.getTime() + 3_600_000))).rows).toBe(1);
    expect((await measureStoredPayload(env, new Date(NOW.getTime() + 25 * 3_600_000))).rows).toBe(2);
  });

  it("keeps the carried-over count honest while it prunes", async () => {
    await seedObject({ id: "https://remote.example/objects/oldest", published: OLD });
    await seedObject({ id: "https://remote.example/objects/newest", published: RECENT });
    expect((await measureStoredPayload(env, NOW)).rows).toBe(2);

    // `measure: false`: no count is retaken, so the figure comes from the
    // carried-over one minus what this pass pruned (the old status only).
    const run = await maintainStorageRetention(
      env,
      { ...DEFAULT_STORAGE_RETENTION, days: 30 },
      new Date(NOW.getTime() + 3_600_000),
      { measure: false }
    );
    expect(run.objectsDeleted).toBe(1);
    expect((await readStorageRetentionStats(env)).estimate.rows).toBe(1);
  });

  it("serves the admin endpoint and audits a manual pass", async () => {
    const restoreBindings = clearRetentionBindings();
    await seedObject({ id: "https://remote.example/objects/old" });
    await seedActivity("act-old", OLD);
    await db.prepare("UPDATE actors SET role = 'admin' WHERE id = ?").bind(LOCAL).run();
    await db
      .prepare(
        `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at)
         VALUES ('t-admin', ?, NULL, 'tok-admin', 'read write', datetime('now'))`
      )
      .bind(LOCAL)
      .run();
    const request = () =>
      new NextRequest("http://local.example/api/v1/admin/storage", {
        headers: { Authorization: "Bearer tok-admin" },
      });

    // Anonymous callers never see the numbers.
    const anonymous = await getStorage(new NextRequest("http://local.example/api/v1/admin/storage"));
    expect(anonymous.status).toBe(401);

    const before = await getStorage(request());
    expect(before.status).toBe(200);
    const config = (await before.json()) as {
      enabled: boolean;
      config: { days: number; max_bytes: number };
      estimate: { databaseBytes: number | null };
    };
    // The variables are not set in the test env: retention is off.
    expect(config.enabled).toBe(false);
    expect(config.config).toMatchObject({ days: 0, max_bytes: 0 });

    // Running a pass while disabled is refused (nothing to do, and it must not
    // silently delete anything).
    const refused = await postStorage(request());
    expect(refused.status).toBe(400);

    // With the variable set, the manual pass runs and lands in the audit log.
    // (The bindings object is writable in the test runtime; the production
    // values come from wrangler.toml.)
    const bindings = env as unknown as Record<string, string>;
    bindings.DB_RETENTION_DAYS = "30";
    const run = await postStorage(request());
    expect(run.status).toBe(200);
    const body = (await run.json()) as { run: { objectsDeleted: number; activitiesDeleted: number } };
    expect(body.run.objectsDeleted).toBe(1);
    expect(body.run.activitiesDeleted).toBe(1);
    const logged = await db
      .prepare("SELECT action, target_type FROM moderation_log WHERE action = 'storage_pruned'")
      .first<{ action: string; target_type: string }>();
    expect(logged).toMatchObject({ action: "storage_pruned", target_type: "instance" });
    restoreBindings();
  });

  it("reports its estimate and last run for the admin panel", async () => {
    await seedObject({ id: "https://remote.example/objects/old" });
    await seedActivity("act-old", OLD);

    await maintainStorageRetention(env, { ...DEFAULT_STORAGE_RETENTION, days: 30 }, NOW);
    const stats = await readStorageRetentionStats(env);

    expect(stats.estimate.bytes).toBeGreaterThan(0);
    expect(stats.lastRun).toMatchObject({ objectsDeleted: 1, activitiesDeleted: 1 });
    expect(stats.lastRun?.bytesFreed).toBeGreaterThan(0);
  });
});
