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
 * rows deleted, `DB_RETENTION_SIZE_BATCH` rows measured), so a large backlog
 * drains over several runs instead of blowing the Worker's CPU budget.
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
 * the incremental payload walk: the bytes of `objects.raw`/`content`/
 * `card_json` and `activities.raw` — the columns that hold the federated
 * documents — counted in rowid windows and published when a pass completes.
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
  /** Rows measured per pass while estimating the stored payload. */
  sizeBatch: number;
}

export const DEFAULT_STORAGE_RETENTION: StorageRetentionLimits = {
  days: 0,
  maxBytes: 0,
  pruneBatch: 500,
  sizeBatch: 2000,
};

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
  /** Last completed payload pass: bytes and rows of the prunable payload, and when it finished. */
  bytes: number;
  rows: number;
  at: string | null;
  /** In-progress pass: rowid cursors and what has been counted so far. */
  objectsCursor: number;
  activitiesCursor: number;
  objectsTotal: number;
  activitiesTotal: number;
  objectsRows: number;
  activitiesRows: number;
  /** Last database size the binding reported (0 when it does not report one). */
  lastSize: number;
  /** Bytes freed since the file last shrank (SQLite reuses those pages). */
  freedBytes: number;
}

const EMPTY_STATE: RetentionState = {
  bytes: 0,
  rows: 0,
  at: null,
  objectsCursor: 0,
  activitiesCursor: 0,
  objectsTotal: 0,
  activitiesTotal: 0,
  objectsRows: 0,
  activitiesRows: 0,
  lastSize: 0,
  freedBytes: 0,
};

export interface StorageRetentionEstimate {
  /** Bytes of prunable payload counted by the last completed pass. */
  bytes: number;
  /** Rows counted by that pass. */
  rows: number;
  /** When that pass finished (null until the first one completes). */
  measuredAt: string | null;
  /** True when this call walked the last window — the estimate is now fresh. */
  completed: boolean;
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
  /** True when the payload walk reached the end of both tables. */
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
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<RetentionState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function writeState(env: RetentionEnv, state: RetentionState): Promise<void> {
  await setInstanceSetting(env.DB, STATE_KEY, JSON.stringify(state));
}

/**
 * Advance the payload walk by one bounded window of `objects` and one of
 * `activities`, and note the database size D1 reports. A full pass costs a few
 * reads per tick instead of one full-table scan; the previous complete total
 * stays in place until a new pass finishes.
 */
async function walkPayload(env: RetentionEnv, state: RetentionState, sizeBatch: number, now: Date): Promise<void> {
  // `NOT INDEXED` pins the rowid scan: with the visibility filter present the
  // planner prefers idx_objects_vis_local_pub and then sorts every matching row
  // (half a million of them) to honour `ORDER BY rowid`.
  const objectsWindow = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last_rowid,
            COALESCE(SUM(LENGTH(raw) + COALESCE(LENGTH(content), 0) + COALESCE(LENGTH(card_json), 0)), 0) AS bytes
       FROM (SELECT rowid, raw, content, card_json FROM objects NOT INDEXED
              WHERE rowid > ? AND is_local = 0 AND visibility IN ('public', 'unlisted')
              ORDER BY rowid LIMIT ?)`
  )
    .bind(state.objectsCursor, sizeBatch)
    .all<{ n: number; last_rowid: number; bytes: number }>();

  const reportedSize = Number(objectsWindow.meta?.size_after ?? 0);
  if (reportedSize > 0) {
    state.freedBytes = nextFreedBytes({ size: state.lastSize, freed: state.freedBytes }, reportedSize);
    state.lastSize = reportedSize;
  }

  const objectsRow = objectsWindow.results?.[0];
  let open = false;
  state.objectsTotal += Number(objectsRow?.bytes ?? 0);
  state.objectsRows += Number(objectsRow?.n ?? 0);
  if (Number(objectsRow?.n ?? 0) < sizeBatch) {
    state.objectsCursor = 0;
  } else {
    state.objectsCursor = Number(objectsRow?.last_rowid ?? 0);
    open = true;
  }

  const activitiesWindow = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last_rowid, COALESCE(SUM(LENGTH(raw)), 0) AS bytes
       FROM (SELECT rowid, raw FROM activities NOT INDEXED WHERE rowid > ? ORDER BY rowid LIMIT ?)`
  )
    .bind(state.activitiesCursor, sizeBatch)
    .all<{ n: number; last_rowid: number; bytes: number }>();

  const activitiesRow = activitiesWindow.results?.[0];
  state.activitiesTotal += Number(activitiesRow?.bytes ?? 0);
  state.activitiesRows += Number(activitiesRow?.n ?? 0);
  if (Number(activitiesRow?.n ?? 0) < sizeBatch) {
    state.activitiesCursor = 0;
  } else {
    state.activitiesCursor = Number(activitiesRow?.last_rowid ?? 0);
    open = true;
  }

  if (!open) {
    // Both tables reached their end: publish the pass and start a fresh one.
    state.bytes = state.objectsTotal + state.activitiesTotal;
    state.rows = state.objectsRows + state.activitiesRows;
    state.at = now.toISOString();
    state.objectsTotal = 0;
    state.activitiesTotal = 0;
    state.objectsRows = 0;
    state.activitiesRows = 0;
  }
}

function toEstimate(state: RetentionState, completed: boolean): StorageRetentionEstimate {
  return {
    bytes: state.bytes,
    rows: state.rows,
    measuredAt: state.at,
    completed,
    databaseBytes: state.lastSize > 0 ? state.lastSize : null,
    effectiveBytes: effectiveBytes(state),
  };
}

/** Measure the stored payload (one bounded window) and report the current estimate. */
export async function measureStoredPayload(
  env: RetentionEnv,
  sizeBatch: number,
  now: Date = new Date()
): Promise<StorageRetentionEstimate> {
  const state = await readState(env);
  const before = state.at;
  await walkPayload(env, state, sizeBatch, now);
  await writeState(env, state);
  return toEstimate(state, state.at !== before);
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
  now: Date = new Date()
): Promise<StorageRetentionRun> {
  const run: StorageRetentionRun = {
    enabled: false,
    objectsDeleted: 0,
    activitiesDeleted: 0,
    bytesFreed: 0,
    effectiveBytes: 0,
    databaseBytes: null,
    measured: false,
  };
  if (!isStorageRetentionEnabled(limits)) return run;
  run.enabled = true;

  const state = await readState(env);
  const before = state.at;
  await walkPayload(env, state, limits.sizeBatch, now);
  run.measured = state.at !== before;
  run.databaseBytes = state.lastSize > 0 ? state.lastSize : null;
  run.effectiveBytes = effectiveBytes(state);

  const applyPruned = (pruned: PruneResult) => {
    run.objectsDeleted += pruned.objects;
    run.activitiesDeleted += pruned.activities;
    run.bytesFreed += pruned.bytes;
    state.freedBytes += pruned.bytes;
    run.effectiveBytes = effectiveBytes(state);
  };

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
