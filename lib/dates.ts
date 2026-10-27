/**
 * Every date conversion the app needs, in one place.
 *
 * Two shapes coexist on purpose and must never be guessed:
 *
 *  - **The database's own shape** (`datetime('now')`): `YYYY-MM-DD HH:MM:SS`,
 *    UTC, no zone marker. SQLite writes it, `datetime()`/`date()` parse it, and
 *    a plain string comparison against `datetime('now')` (and the index that
 *    backs it) only works while **the whole column keeps this shape**.
 *  - **ISO 8601** (`YYYY-MM-DDTHH:MM:SS.sssZ`): what ActivityPub documents, the
 *    Mastodon API, RSS/Atom and every JavaScript date parser expect. A bare
 *    `new Date("2026-10-23 19:33:23")` reads the database shape as *local* time
 *    (an action applied in Madrid showed as two hours old) and a Z-less ISO
 *    string is read as local too, so **nothing may cross the boundary without
 *    one of these helpers**.
 *
 * Rules of thumb:
 *  - writing a JS date into a DB column → `dbTimestamp()`;
 *  - sending a stored value to a peer/client → `isoTimestamp()` (never-null) or
 *    `toIsoOrNull()` (a missing date stays missing);
 *  - reading a stored value in the browser → `parseDbDate()`.
 *
 * The columns carrying AP-derived timestamps (`objects.published`,
 * `objects.updated_at`, `announces.created_at`, `follows.created_at`) are ISO
 * because they are ordered against each other (`sort_at` in the home timeline
 * UNION) and quoted back to the fediverse; the rest are the database shape.
 * Mixing both inside one column silently breaks ordering: SQLite compares
 * `'2026-10-23 18:00:00' > '2026-10-23T10:00:00.000Z'` as false, so an 18:00
 * boost sorted below a 10:00 one. `scripts/upgrade-schema.mjs` normalises the
 * mixed columns (`backfill:dates_*`) and the writers keep them uniform.
 */

const DB_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** ISO without a zone: our own migrations/tools can emit it, JS would read it as local. */
const ISO_WITHOUT_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/** ISO 8601 (UTC, `Z`) or `null` when the value is missing/unparseable. */
export function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  // Normalise the zone *before* parsing (a Z-less ISO would be read as local
  // time) and re-serialise afterwards: every caller gets the exact shape
  // `toISOString()` produces (milliseconds included), so two of these values
  // can be compared as strings without a subtle "same second, different text"
  // mismatch.
  const iso = DB_SHAPE.test(value)
    ? `${value.replace(" ", "T")}Z`
    : ISO_WITHOUT_ZONE.test(value)
      ? `${value}Z`
      : value;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * ISO 8601 (UTC, `Z`), falling back to *now* for a missing or unparseable
 * value — the ActivityPub builders' contract (a document always carries a
 * usable date).
 */
export function isoTimestamp(value: unknown): string {
  return toIsoOrNull(value) ?? new Date().toISOString();
}

/**
 * Whether an AP `published` value still lies in the future — a remote server
 * with a skewed clock (a WordPress ActivityPub plugin publishing local time as
 * UTC, measured on cf-ap: posts pinned to the top of every timeline for hours)
 * can send one. Such a status is stored untouched, but timelines and streams
 * hide it until its instant arrives (SQL side: `notInFutureSql` in lib/db).
 * Unparseable values are NOT treated as future (fail open: a strange date
 * must never make a legitimate post invisible).
 */
export function isPublishedInFuture(value: unknown, now = Date.now()): boolean {
  const iso = toIsoOrNull(value);
  if (!iso) return false;
  return Date.parse(iso) > now;
}

/**
 * The database's shape for a JS date: UTC, second precision, no zone marker —
 * what `datetime('now')` writes and what a raw `column < datetime('now')`
 * comparison expects.
 */
export function dbTimestamp(value: Date | number | string = Date.now()): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Parse a stored timestamp into a `Date` for the browser. Accepts both shapes,
 * so an admin payload that still carries raw database values renders in the
 * viewer's zone instead of two hours off.
 */
export function parseDbDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  // `toIsoOrNull` covers both stored shapes and the Z-less ISO trap; a
  // date-only value ("2026-10-23") is a UTC day, which is what callers want.
  const iso = toIsoOrNull(value);
  return iso ? new Date(iso) : null;
}
