/**
 * Storage retention — how much federated history this instance keeps.
 *
 * A federated server stores what other servers send it: every remote status
 * (its ActivityPub document, its text and its link-preview snapshot) and every
 * processed activity id kept for replay protection. That is the fediverse's
 * memory, and by default this instance keeps all of it — but on a metered D1
 * database an operator needs a ceiling. Two independent environment variables
 * provide it, both disabled at 0 (the default):
 *
 *   DB_RETENTION_DAYS       delete federated history older than N days.
 *   DB_RETENTION_MAX_BYTES  while the database is over this many bytes, prune
 *                           the oldest federated history first.
 *
 * The pass runs from the cron, bounded per tick (`DB_RETENTION_PRUNE_BATCH`
 * rows deleted), so a large backlog drains over several runs instead of blowing
 * the Worker's CPU budget.
 *
 * Measuring the prunable payload used to read **every** row of `objects` and
 * `activities` in rowid windows to sum `LENGTH(raw)` — 10k payloads per call,
 * 1.8k calls a day, and 78% of the database's execution time between the two
 * walks. It is now a **sample**: eight rowid probes spread across each table,
 * `DB_RETENTION_SIZE_BATCH` payloads each, whose average is multiplied by an
 * index-only row count. ±3% of the figure the exhaustive walk produced, for
 * ~0.2% of its cost, and the count is exact.
 *
 * What retention never touches:
 *   - local accounts' own statuses (your data, not a cache);
 *   - direct messages and followers-only posts from remote accounts (personal
 *     content, not public history);
 *   - remote posts a local account bookmarked or replied to (their library and
 *     their thread);
 *   - accounts, follows, lists, filters, reports and the moderation log.
 *
 * Deleting a status cascades its attachments, likes, boosts, bookmarks, poll
 * rows, tags and notifications, exactly like the origin deleting it, and the
 * media-cache maintenance then drops the R2 copy it no longer needs. The reply
 * counter of a surviving parent is corrected in the same pass; the author's
 * `statuses_count` is the number the remote server advertises (never recomputed
 * from what we happen to store), so it stays untouched.
 *
 * How the byte budget is measured: D1 reports the real file size in every
 * statement's `meta.size_after`, so the budget compares against that. SQLite
 * does not shrink the file when rows are deleted — the freed pages are reused
 * by later inserts — so the pass also remembers how many bytes it has freed
 * since the file last shrank (`freedBytes`) and budgets `size - freed`: that is
 * the number that decides whether the database will keep growing. A runtime
 * that does not report the size (Miniflare in tests, local dev) falls back to
 * the sampled payload estimate: the average bytes of `objects.raw`/`content`/
 * `card_json` and `activities.raw` — the columns that hold the federated
 * documents — times their row counts.
 */

import { getInstanceSetting, setInstanceSetting } from "@/lib/db";
import { resolveLimits, type InstanceLimits } from "@/lib/constants";

/** The bindings a retention pass needs. */
export interface RetentionEnv {
  DB: D1Database;
}

export interface StorageRetentionLimits {
  /** Delete federated history older than this many days (0 = keep forever). */
  days: number;
  /** Prune the oldest federated history while the database exceeds this many bytes (0 = unlimited). */
  maxBytes: number;
  /** Rows deleted per pass. */
  pruneBatch: number;
  /**
   * Payloads read **per probe** while sampling the stored payload (the estimate
   * reads `SAMPLE_POINTS` probes spread across each table, so the total rows read
   * is `sizeBatch × SAMPLE_POINTS × 2`).
   */
  sizeBatch: number;
}

export const DEFAULT_STORAGE_RETENTION: StorageRetentionLimits = {
  days: 0,
  maxBytes: 0,
  pruneBatch: 500,
  sizeBatch: 1000,
};

/**
 * Probes spread across each table's rowid range, and the ceiling a single probe
 * may read (`DB_RETENTION_SIZE_BATCH` is clamped to it: the old meaning of that
 * variable was thousands of rows per window, which is exactly the cost the
 * sampling replaced).
 */
const SAMPLE_POINTS = 8;
const MAX_SAMPLE_ROWS = 1000;

/**
 * How many prune batches one pass may run while the instance is over its byte
 * budget: enough to drain a backlog in hours, bounded enough to keep the tick
 * inside its CPU budget.
 */
const MAX_SIZE_BATCHES = 4;

/** Retention state (`instance_settings`). */
const STATE_KEY = "db:size";
/** Summary of the last run, for the admin panel. */
const LAST_RUN_KEY = "db:retention:last";

/** Statuses retention is allowed to prune. Local, private and direct content never is. */
const PRUNABLE_VISIBILITIES = ["public", "unlisted"] as const;

/** A cutoff that keeps the "no age limit" path on the same indexed plan. */
const NO_CUTOFF = "9999-12-31T00:00:00.000Z";

interface RetentionState {
  /** State format (an older one is restarted, keeping the size bookkeeping). */
  version: number;
  /** Last measurement: bytes and rows of the prunable payload, and when it was taken. */
  bytes: number;
  rows: number;
  at: string | null;
  /** Last database size the binding reported (0 when it does not report one). */
  lastSize: number;
  /** Bytes freed since the file last shrank (SQLite reuses those pages). */
  freedBytes: number;
}

/** Bumped when the state shape changes (an older one is restarted). */
const STATE_VERSION = 3;

const EMPTY_STATE: RetentionState = {
  version: STATE_VERSION,
  bytes: 0,
  rows: 0,
  at: null,
  lastSize: 0,
  freedBytes: 0,
};

export interface StorageRetentionEstimate {
  /** Bytes of prunable payload estimated by the last sample. */
  bytes: number;
  /** Exact number of prunable rows. */
  rows: number;
  /** When the last sample was taken (null until the first one). */
  measuredAt: string | null;
  /** True when this call took a fresh sample. */
  completed: boolean;
  /** True until the first sample lands (the panel shows "measuring"). */
  measuring: boolean;
  /** Database size reported by D1 (null when the runtime does not report one). */
  databaseBytes: number | null;
  /** What the byte budget is compared against: `size - freed`, or the payload estimate. */
  effectiveBytes: number;
}

export interface StorageRetentionRun {
  /** False when both knobs are 0 — nothing was read or written. */
  enabled: boolean;
  objectsDeleted: number;
  activitiesDeleted: number;
  bytesFreed: number;
  /** Effective bytes after the pass (see `StorageRetentionEstimate`). */
  effectiveBytes: number;
  /** Database size reported by D1 during the pass (null when unavailable). */
  databaseBytes: number | null;
  /** True when the pass took a fresh payload sample (the estimate is fresh). */
  measured: boolean;
}

export interface StorageRetentionStats {
  estimate: StorageRetentionEstimate;
  lastRun: (Omit<StorageRetentionRun, "enabled"> & { at: string }) | null;
}

/** Typechecked bridge from `resolveLimits()` to this module (the cron's own contract). */
export function storageRetentionLimitsFrom(limits: InstanceLimits): StorageRetentionLimits {
  return {
    days: limits.dbRetentionDays,
    maxBytes: limits.dbRetentionMaxBytes,
    pruneBatch: limits.dbRetentionPruneBatch,
    sizeBatch: limits.dbRetentionSizeBatch,
  };
}

/** Convenience for callers that only hold the raw env. */
export function resolveStorageRetentionLimits(env: Record<string, unknown>): StorageRetentionLimits {
  return storageRetentionLimitsFrom(resolveLimits(env));
}

export function isStorageRetentionEnabled(limits: StorageRetentionLimits): boolean {
  return limits.days > 0 || limits.maxBytes > 0;
}

/**
 * Fold a freshly observed database size into the freed-bytes bookkeeping.
 *
 * SQLite never shrinks its file when rows are deleted: the pages are reused by
 * the next inserts. So "how much live data is there" is `size - freed`, where
 * `freed` counts what retention deleted since the file last shrank. A growing
 * file means inserts consumed the free pages, so the freed credit shrinks with
 * it; a smaller file means it was compacted, and the credit resets.
 */
export function nextFreedBytes(previous: { size: number; freed: number }, size: number): number {
  if (previous.size <= 0 || size <= 0) return previous.freed;
  if (size < previous.size) return 0;
  return Math.max(0, previous.freed - (size - previous.size));
}

function effectiveBytes(state: RetentionState): number {
  if (state.lastSize > 0) return Math.max(0, state.lastSize - state.freedBytes);
  return state.bytes;
}

async function readState(env: RetentionEnv): Promise<RetentionState> {
  const raw = await getInstanceSetting(env.DB, STATE_KEY).catch(() => null);
  if (!raw) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<RetentionState>;
    const state = { ...EMPTY_STATE, ...parsed };
    if (parsed.version !== STATE_VERSION) {
      // An older state carried the cursor-based walk: keep what still means
      // something (the size bookkeeping) and take a fresh sample.
      return { ...EMPTY_STATE, lastSize: state.lastSize, freedBytes: state.freedBytes };
    }
    return state;
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function writeState(env: RetentionEnv, state: RetentionState): Promise<void> {
  await setInstanceSetting(env.DB, STATE_KEY, JSON.stringify(state));
}

interface PayloadSample {
  /** Exact number of matching rows (index-only count: no payload is read). */
  total: number;
  sampledRows: number;
  sampledBytes: number;
  /** The size D1 reported for one of the probes (0 when it reports none). */
  sizeAfter: number;
}

/**
 * Rowid starting points spread across the table, jittered inside each step:
 * a fixed grid samples the same neighbourhoods on every measure, so a
 * positional pattern in the payload sizes biases every result the same way
 * (measured on cf-ap: two fixed grids landed 4.6% and 2.9% below the
 * exhaustive walk). The jitter averages that out over the following measures.
 */
function sampleStarts(maxRowid: number): number[] {
  const step = Math.max(1, Math.floor(maxRowid / SAMPLE_POINTS));
  return Array.from({ length: SAMPLE_POINTS }, (_, i) => i * step + Math.floor(Math.random() * step));
}

/** The walk's row count comes from an index-only count, never from the payload. */
async function countObjectsPayloadRows(env: RetentionEnv): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM objects INDEXED BY idx_objects_vis_local_pub
      WHERE visibility IN ('public', 'unlisted') AND is_local = 0`
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function sampleObjectsPayload(env: RetentionEnv, probeRows: number): Promise<PayloadSample> {
  const max = Number(
    (await env.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS max FROM objects").first<{ max: number }>())?.max ?? 0
  );
  const total = await countObjectsPayloadRows(env);
  let sampledRows = 0;
  let sampledBytes = 0;
  let sizeAfter = 0;
  for (const from of sampleStarts(max)) {
    // A rowid seek (the primary key): SQLite starts at `from` and stops after
    // `probeRows` matches, instead of reading the whole table to sum it.
    const result = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(LENGTH(raw) + COALESCE(LENGTH(content), 0) + COALESCE(LENGTH(card_json), 0)), 0) AS bytes
           FROM (SELECT raw, content, card_json FROM objects
                  WHERE rowid > ? AND is_local = 0 AND visibility IN ('public', 'unlisted')
                  LIMIT ?)`
      )
      .bind(from, probeRows)
      .all<{ n: number; bytes: number }>();
    sampledRows += Number(result.results?.[0]?.n ?? 0);
    sampledBytes += Number(result.results?.[0]?.bytes ?? 0);
    if (!sizeAfter) sizeAfter = Number(result.meta?.size_after ?? 0);
  }
  return { total, sampledRows, sampledBytes, sizeAfter };
}

async function sampleActivitiesPayload(env: RetentionEnv, probeRows: number): Promise<PayloadSample> {
  const max = Number(
    (await env.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS max FROM activities").first<{ max: number }>())?.max ?? 0
  );
  // The count rides the smallest index (`idx_activities_published`): one entry
  // per row and no payload read.
  const total = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM activities").first<{ n: number }>())?.n ?? 0);
  let sampledRows = 0;
  let sampledBytes = 0;
  let sizeAfter = 0;
  for (const from of sampleStarts(max)) {
    const result = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(raw)), 0) AS bytes
           FROM (SELECT raw FROM activities WHERE rowid > ? LIMIT ?)`
      )
      .bind(from, probeRows)
      .all<{ n: number; bytes: number }>();
    sampledRows += Number(result.results?.[0]?.n ?? 0);
    sampledBytes += Number(result.results?.[0]?.bytes ?? 0);
    if (!sizeAfter) sizeAfter = Number(result.meta?.size_after ?? 0);
  }
  return { total, sampledRows, sampledBytes, sizeAfter };
}

/** Extrapolate a probe's average to the table's exact row count. */
function estimateSample(sample: PayloadSample): number {
  if (sample.sampledRows === 0) return 0;
  return Math.round((sample.sampledBytes / sample.sampledRows) * sample.total);
}

/**
 * Measure the stored payload: `SAMPLE_POINTS` probes per table (a rowid seek
 * each, `sizeBatch` payloads) whose average is extrapolated to the exact row
 * count, plus the database size D1 reports. The previous estimate stays in
 * place until this finishes.
 */
async function measurePayload(env: RetentionEnv, state: RetentionState, sizeBatch: number, now: Date): Promise<void> {
  const probeRows = Math.min(Math.max(50, Math.floor(sizeBatch)), MAX_SAMPLE_ROWS);
  const objects = await sampleObjectsPayload(env, probeRows);
  const activities = await sampleActivitiesPayload(env, probeRows);

  state.bytes = estimateSample(objects) + estimateSample(activities);
  state.rows = objects.total + activities.total;
  state.at = now.toISOString();

  const reportedSize = objects.sizeAfter || activities.sizeAfter;
  if (reportedSize > 0) {
    state.freedBytes = nextFreedBytes({ size: state.lastSize, freed: state.freedBytes }, reportedSize);
    state.lastSize = reportedSize;
  }
}

function toEstimate(state: RetentionState, completed: boolean): StorageRetentionEstimate {
  return {
    bytes: state.bytes,
    rows: state.rows,
    measuredAt: state.at,
    completed,
    // No measurement has been taken yet: the panel shows "measuring" until the
    // first sample lands (the first cron tick after deploy).
    measuring: state.at === null,
    databaseBytes: state.lastSize > 0 ? state.lastSize : null,
    effectiveBytes: effectiveBytes(state),
  };
}

/** Take a fresh payload sample and report the current estimate. */
export async function measureStoredPayload(
  env: RetentionEnv,
  now: Date = new Date(),
  sizeBatch: number = DEFAULT_STORAGE_RETENTION.sizeBatch
): Promise<StorageRetentionEstimate> {
  const state = await readState(env);
  await measurePayload(env, state, sizeBatch, now);
  await writeState(env, state);
  return toEstimate(state, true);
}

function objectBranch(visibility: string): string {
  // One branch per visibility with its own ordered index scan: `visibility IN
  // (...)` on the leading column would defeat the index (the planner falls back
  // to a scan + sort) and the LIMIT would no longer stop early.
  return `SELECT * FROM (
    SELECT id, published,
           LENGTH(raw) + COALESCE(LENGTH(content), 0) + COALESCE(LENGTH(card_json), 0) AS bytes
      FROM objects INDEXED BY idx_objects_vis_published
     WHERE visibility = '${visibility}'
       AND is_local = 0
       AND published < ?
       AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.object_id = objects.id)
       AND NOT EXISTS (SELECT 1 FROM objects r WHERE r.in_reply_to_id = objects.id AND r.is_local = 1)
     ORDER BY published ASC
     LIMIT ?
  )`;
}

export interface PruneResult {
  objects: number;
  activities: number;
  bytes: number;
}

/**
 * Delete one batch of federated history: the oldest remote public/unlisted
 * statuses before `cutoff` and the oldest processed activities.
 */
export async function pruneFederatedHistory(
  env: RetentionEnv,
  opts: { cutoff: string; limit: number }
): Promise<PruneResult> {
  const result: PruneResult = { objects: 0, activities: 0, bytes: 0 };
  if (opts.limit <= 0) return result;

  const branches = PRUNABLE_VISIBILITIES.map(objectBranch);
  const rows = await env.DB.prepare(
    `SELECT id, published, bytes FROM (${branches.join(" UNION ALL ")}) ORDER BY published ASC LIMIT ?`
  )
    .bind(...branches.flatMap(() => [opts.cutoff, opts.limit]), opts.limit)
    .all<{ id: string; published: string; bytes: number }>();

  const ids = (rows.results ?? []).map((row) => row.id);
  if (ids.length > 0) {
    const idsJson = JSON.stringify(ids);
    await env.DB.batch([
      // Keep the denormalized counters of surviving parents honest: a pruned
      // reply must release its slot in `replies_count`/`engagement`. Parents
      // deleted in this same batch are excluded (their row is going away).
      env.DB
        .prepare(
          `WITH pruned(parent_id, n) AS (
             SELECT in_reply_to_id, COUNT(*) FROM objects
              WHERE id IN (SELECT value FROM json_each(?)) AND in_reply_to_id IS NOT NULL
              GROUP BY in_reply_to_id
           )
           UPDATE objects SET
             replies_count = MAX(COALESCE(replies_count, 0) - COALESCE((SELECT n FROM pruned p WHERE p.parent_id = objects.id), 0), 0),
             engagement    = MAX(COALESCE(engagement, 0)    - COALESCE((SELECT n FROM pruned p WHERE p.parent_id = objects.id), 0), 0)
           WHERE id IN (SELECT parent_id FROM pruned)
             AND id NOT IN (SELECT value FROM json_each(?))`
        )
        .bind(idsJson, idsJson),
      // Tables that reference objects without a FK (the same set `deleteObject`
      // cleans): pins, filter entries and notifications.
      env.DB.prepare("DELETE FROM status_pins WHERE status_id IN (SELECT value FROM json_each(?))").bind(idsJson),
      env.DB.prepare("DELETE FROM custom_filter_statuses WHERE status_id IN (SELECT value FROM json_each(?))").bind(idsJson),
      env.DB.prepare("DELETE FROM notifications WHERE object_id IN (SELECT value FROM json_each(?))").bind(idsJson),
      // The rest (attachments, likes, announces, bookmarks, polls, tags, edits,
      // quote authorizations, the link-preview queue) cascades.
      env.DB.prepare("DELETE FROM objects WHERE id IN (SELECT value FROM json_each(?))").bind(idsJson),
    ]);
    result.objects = ids.length;
    result.bytes += (rows.results ?? []).reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);
  }

  // Processed activities are write-only replay protection: their raw document
  // is never read again, so the oldest ones are the cheapest bytes to reclaim.
  const activities = await env.DB.prepare(
    `SELECT id, LENGTH(raw) AS bytes FROM activities INDEXED BY idx_activities_published
      WHERE published < ? ORDER BY published ASC LIMIT ?`
  )
    .bind(opts.cutoff, opts.limit)
    .all<{ id: string; bytes: number }>();

  const activityIds = (activities.results ?? []).map((row) => row.id);
  if (activityIds.length > 0) {
    await env.DB.prepare("DELETE FROM activities WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(activityIds))
      .run();
    result.activities = activityIds.length;
    result.bytes += (activities.results ?? []).reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);
  }

  return result;
}

function isoBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * One retention pass: refresh the size estimate, then delete what the age
 * window and the byte budget have expired. Bounded per call — the cron runs it
 * every tick and a backlog drains over the following ones.
 */
export async function maintainStorageRetention(
  env: RetentionEnv,
  limits: StorageRetentionLimits,
  now: Date = new Date(),
  options: { measure?: boolean } = {}
): Promise<StorageRetentionRun> {
  const run: StorageRetentionRun = {
    enabled: isStorageRetentionEnabled(limits),
    objectsDeleted: 0,
    activitiesDeleted: 0,
    bytesFreed: 0,
    effectiveBytes: 0,
    databaseBytes: null,
    measured: false,
  };

  // The sample runs even with retention disabled (the admin panel shows the
  // federated history it measures), but not on every pass: the cron asks for it
  // a few times a day, while **every** pass refreshes the database size — the
  // number the byte budget is compared against.
  const state = await readState(env);
  if (options.measure !== false) {
    await measurePayload(env, state, limits.sizeBatch, now);
    run.measured = true;
  } else {
    const reported = await currentDatabaseBytes(env).catch(() => 0);
    if (reported > 0) {
      state.freedBytes = nextFreedBytes({ size: state.lastSize, freed: state.freedBytes }, reported);
      state.lastSize = reported;
    }
  }
  run.databaseBytes = state.lastSize > 0 ? state.lastSize : null;
  run.effectiveBytes = effectiveBytes(state);

  const applyPruned = (pruned: PruneResult) => {
    run.objectsDeleted += pruned.objects;
    run.activitiesDeleted += pruned.activities;
    run.bytesFreed += pruned.bytes;
    state.freedBytes += pruned.bytes;
    run.effectiveBytes = effectiveBytes(state);
  };

  if (!run.enabled) {
    await writeState(env, state);
    return run;
  }

  if (limits.days > 0) {
    applyPruned(
      await pruneFederatedHistory(env, { cutoff: isoBefore(now, limits.days), limit: limits.pruneBatch })
    );
  }

  if (limits.maxBytes > 0) {
    for (let batch = 0; batch < MAX_SIZE_BATCHES && run.effectiveBytes > limits.maxBytes; batch++) {
      const pruned = await pruneFederatedHistory(env, { cutoff: NO_CUTOFF, limit: limits.pruneBatch });
      if (pruned.objects === 0 && pruned.activities === 0) break;
      applyPruned(pruned);
    }
  }

  await writeState(env, state);

  if (run.objectsDeleted > 0 || run.activitiesDeleted > 0) {
    await setInstanceSetting(
      env.DB,
      LAST_RUN_KEY,
      JSON.stringify({
        at: now.toISOString(),
        objectsDeleted: run.objectsDeleted,
        activitiesDeleted: run.activitiesDeleted,
        bytesFreed: run.bytesFreed,
        effectiveBytes: run.effectiveBytes,
        databaseBytes: run.databaseBytes,
      })
    );
  }
  return run;
}

/**
 * The database size D1 reports right now. Every statement's meta carries it, so
 * a read-only probe is enough — used by the admin panel before the first
 * retention pass has ever run.
 */
async function currentDatabaseBytes(env: RetentionEnv): Promise<number> {
  const result = await env.DB.prepare("SELECT 1").all();
  return Number(result.meta?.size_after ?? 0);
}

/** What the admin panel shows: the current estimate and the last deletion pass. */
export async function readStorageRetentionStats(env: RetentionEnv): Promise<StorageRetentionStats> {
  const state = await readState(env);
  if (state.lastSize <= 0) {
    const reported = await currentDatabaseBytes(env).catch(() => 0);
    if (reported > 0) state.lastSize = reported;
  }
  const lastRunRaw = await getInstanceSetting(env.DB, LAST_RUN_KEY).catch(() => null);
  let lastRun: StorageRetentionStats["lastRun"] = null;
  if (lastRunRaw) {
    try {
      lastRun = JSON.parse(lastRunRaw) as StorageRetentionStats["lastRun"];
    } catch {
      lastRun = null;
    }
  }
  return { estimate: toEstimate(state, false), lastRun };
}
