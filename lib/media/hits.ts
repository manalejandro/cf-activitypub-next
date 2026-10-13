/**
 * Media cache popularity counters.
 *
 * The serve path runs for every cache miss that reaches the Worker, so it must
 * not touch D1 per request: hits are counted in memory and flushed as a single
 * batch (interval or size), and the hot path never awaits it. Losing a few
 * counts when an isolate is recycled is fine — the signal is statistical and
 * only decides the eviction order.
 */

import { resolveLimits } from "@/lib/constants";

type HitsDb = {
  prepare(sql: string): { bind(...args: unknown[]): { run(): Promise<unknown> } };
  batch?(statements: { run(): Promise<unknown> }[]): Promise<unknown>;
};

const pending = new Map<string, number>();
let lastFlush = Date.now();

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_AT_KEYS = 200;
const FLUSH_MAX_STATEMENTS = 500;

/** Count one served media object (in memory, no I/O). */
export function recordMediaHit(r2Key: string): void {
  if (!r2Key) return;
  pending.set(r2Key, (pending.get(r2Key) ?? 0) + 1);
}

/**
 * The aging window: the attachment retention (`MEDIA_CACHE_DAYS`), resolved
 * once (the serve path is hot). A file that stayed quiet for longer than its
 * own lifetime restarts its counter on the next serve.
 */
let hitWindowDays: number | null = null;

export function mediaHitWindowDays(env: Record<string, unknown>): number {
  if (hitWindowDays === null) {
    hitWindowDays = resolveLimits(env).mediaCacheDays;
  }
  return hitWindowDays;
}

/** Test helper: forget the cached aging window. */
export function __resetMediaHitWindow(): void {
  hitWindowDays = null;
}

/**
 * Flush the pending counts when due (`force` for teardown paths).
 *
 * An entry not served for `windowDays` (the attachment retention) restarts its
 * counter on the next serve, so a file that went cold and came back is judged
 * by its recent use instead of a lifetime total.
 */
export async function flushMediaHits(db: HitsDb, force = false, windowDays = 30): Promise<void> {
  if (pending.size === 0) return;
  if (!force && pending.size < FLUSH_AT_KEYS && Date.now() - lastFlush < FLUSH_INTERVAL_MS) return;
  const entries = [...pending.entries()].slice(0, FLUSH_MAX_STATEMENTS);
  for (const [key] of entries) pending.delete(key);
  lastFlush = Date.now();
  const window = `-${Math.max(1, Math.floor(windowDays))} days`;
  const statements = entries.map(([key, count]) =>
    db
      .prepare(
        `UPDATE media_cache
            SET hits = CASE WHEN hits_at IS NULL OR hits_at < datetime('now', ?) THEN ? ELSE hits + ? END,
                hits_at = CASE WHEN hits_at IS NULL OR hits_at < datetime('now', ?) THEN datetime('now') ELSE hits_at END,
                last_hit_at = datetime('now')
          WHERE r2_key = ?`
      )
      .bind(window, count, count, window, key)
  );
  try {
    if (typeof db.batch === "function") await db.batch(statements);
    else for (const statement of statements) await statement.run();
  } catch { /* best-effort: a lost batch only skews the eviction order */ }
}

/** Test helper: drop pending counts and restart the flush interval. */
export function __resetMediaHits(): void {
  pending.clear();
  lastFlush = Date.now();
}
