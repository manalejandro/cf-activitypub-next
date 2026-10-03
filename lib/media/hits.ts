/**
 * Media cache popularity counters.
 *
 * The serve path runs for every cache miss that reaches the Worker, so it must
 * not touch D1 per request: hits are counted in memory and flushed as a single
 * batch (interval or size), and the hot path never awaits it. Losing a few
 * counts when an isolate is recycled is fine — the signal is statistical and
 * only decides the eviction order.
 */

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
 * Flush the pending counts when due (`force` for teardown paths). The window
 * resets after 30 days of no use, so a formerly popular entry ages out and can
 * be evicted again.
 */
export async function flushMediaHits(db: HitsDb, force = false): Promise<void> {
  if (pending.size === 0) return;
  if (!force && pending.size < FLUSH_AT_KEYS && Date.now() - lastFlush < FLUSH_INTERVAL_MS) return;
  const entries = [...pending.entries()].slice(0, FLUSH_MAX_STATEMENTS);
  for (const [key] of entries) pending.delete(key);
  lastFlush = Date.now();
  const statements = entries.map(([key, count]) =>
    db
      .prepare(
        `UPDATE media_cache
            SET hits = CASE WHEN hits_at IS NULL OR hits_at < datetime('now', '-30 days') THEN ? ELSE hits + ? END,
                hits_at = CASE WHEN hits_at IS NULL OR hits_at < datetime('now', '-30 days') THEN datetime('now') ELSE hits_at END,
                last_hit_at = datetime('now')
          WHERE r2_key = ?`
      )
      .bind(count, count, key)
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
