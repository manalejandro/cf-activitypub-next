import type { D1Database } from "@cloudflare/workers-types";
import { getInstanceSetting, setInstanceSetting } from "@/lib/db";

/**
 * Minimal R2 surface (the generated binding and workers-types disagree on the
 * ambient type, same as in lib/account-deletion.ts).
 */
export interface OrphanUploadBucket {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

/**
 * Sweep of abandoned user uploads (`media/<user>/…` keys in R2).
 *
 * An upload lands in R2 immediately and in `attachments` only when a status
 * uses it; a `pending_media:` KV entry covers at most an hour (30 days when a
 * scheduled post extends it). Uploads that are never attached — a discarded
 * composer draft, a failed post — stayed in the bucket forever. Account
 * deletion already removes that account's prefix (lib/account-deletion.ts);
 * this sweep covers everything else.
 *
 * Safety rails, in order:
 *  - only keys older than `minAgeDays` (default 31 — above the 30-day TTL a
 *    scheduled post can extend a pending upload to);
 *  - a key referenced by any attachment, avatar, header or emoji URL survives
 *    (suffix match, so any historical host shape in the stored URL counts);
 *  - a key whose upload id appears in a scheduled post's `media_ids` survives;
 *  - bounded per pass (list batch + delete budget) with the R2 list cursor in
 *    `instance_settings`, so a large bucket drains over many cheap passes.
 */

export interface OrphanUploadBindings {
  DB: D1Database;
  R2?: OrphanUploadBucket;
}

export interface OrphanUploadLimits {
  /** R2 keys listed per pass. */
  listBatch: number;
  /** Maximum deletions per pass. */
  deleteBatch: number;
  /** Only delete uploads untouched for at least this many days. */
  minAgeDays: number;
}

export const ORPHAN_UPLOAD_LIMITS: OrphanUploadLimits = {
  listBatch: 1000,
  deleteBatch: 200,
  minAgeDays: 31,
};

const CURSOR_KEY = "upload_orphans_cursor";
const MEDIA_PREFIX = "media/";
const SERVE_SEGMENT = "/api/media/";

/** The `pending_media` id an upload key was created from (v1 `<32hex>.<ext>`, v2 `<uuid36>-<name>`). */
export function uploadIdFromKey(key: string): string {
  const base = key.split("/").pop() ?? "";
  // v2 upload: `<uuid-with-dashes>-<file name>` — the first dash belongs to
  // the UUID itself, so match the full shape instead of splitting on "-".
  const v2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i.exec(base);
  if (v2) return v2[0].slice(0, -1);
  // v1 upload: `<32hex>.<ext>`.
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export async function sweepOrphanUploads(
  bindings: OrphanUploadBindings,
  limits: OrphanUploadLimits = ORPHAN_UPLOAD_LIMITS
): Promise<{ scanned: number; deleted: number }> {
  const { DB, R2 } = bindings;
  if (!R2) return { scanned: 0, deleted: 0 };

  let cursor = (await getInstanceSetting(DB, CURSOR_KEY).catch(() => null)) || undefined;
  let listed: Awaited<ReturnType<OrphanUploadBucket["list"]>>;
  try {
    listed = await R2.list({ prefix: MEDIA_PREFIX, cursor, limit: limits.listBatch });
  } catch (err) {
    // A persisted R2 cursor can expire or come from a since-changed bucket. On
    // failure with a stored cursor, reset to the beginning and retry ONCE so the
    // stage self-heals instead of wedging forever on the same bad cursor (the
    // cron's try/catch would otherwise swallow the error and never clear it).
    if (!cursor) throw err;
    cursor = undefined;
    await setInstanceSetting(DB, CURSOR_KEY, "").catch(() => {});
    listed = await R2.list({ prefix: MEDIA_PREFIX, limit: limits.listBatch });
  }
  // Persist where the next pass continues; an exhausted list restarts from the
  // beginning (keys deleted/added in between are picked up on later cycles).
  await setInstanceSetting(DB, CURSOR_KEY, listed.truncated ? listed.cursor ?? "" : "").catch(() => {});

  const cutoff = Date.now() - limits.minAgeDays * 86_400_000;
  const candidates = listed.objects.filter((o) => o.uploaded.getTime() < cutoff);
  if (candidates.length === 0) return { scanned: listed.objects.length, deleted: 0 };

  // Every /api/media/ reference in one pass (the sweep is cursor-bounded and
  // runs a few times a day at most, so one UNION scan per pass is cheap
  // compared to a probe per key).
  const rows = await DB.prepare(
    `SELECT url AS u FROM attachments WHERE url LIKE '%/api/media/%'
     UNION ALL SELECT avatar_url FROM actors WHERE avatar_url LIKE '%/api/media/%'
     UNION ALL SELECT header_url FROM actors WHERE header_url LIKE '%/api/media/%'
     UNION ALL SELECT url FROM custom_emojis WHERE url LIKE '%/api/media/%'
     UNION ALL SELECT static_url FROM custom_emojis WHERE static_url LIKE '%/api/media/%'`
  ).all<{ u: string }>();
  const referenced = new Set<string>();
  for (const row of rows.results ?? []) {
    const idx = row.u.indexOf(SERVE_SEGMENT);
    if (idx === -1) continue;
    const suffix = row.u.slice(idx + SERVE_SEGMENT.length);
    referenced.add(suffix);
    try {
      // Stored URLs may be percent-encoded (legacy names with spaces): match
      // the decoded key too.
      const decoded = decodeURIComponent(suffix);
      if (decoded !== suffix) referenced.add(decoded);
    } catch { /* malformed encoding — the raw form is enough */ }
  }

  // Uploads reserved by a scheduled post are not orphans, however old the
  // R2 key looks (the pending_media TTL was extended at schedule time).
  const scheduled = new Set<string>();
  try {
    const schedRows = await DB.prepare(
      "SELECT media_ids FROM scheduled_statuses WHERE media_ids IS NOT NULL"
    ).all<{ media_ids: string }>();
    for (const row of schedRows.results ?? []) {
      try {
        for (const id of JSON.parse(row.media_ids) as string[]) scheduled.add(id);
      } catch { /* malformed row */ }
    }
  } catch { /* pre-migration DB without the column */ }

  let deleted = 0;
  for (const object of candidates) {
    if (deleted >= limits.deleteBatch) break;
    if (referenced.has(object.key)) continue;
    if (scheduled.has(uploadIdFromKey(object.key))) continue;
    try {
      await R2.delete(object.key);
      deleted++;
    } catch { /* transient R2 error — retried on a later pass */ }
  }

  return { scanned: listed.objects.length, deleted };
}
