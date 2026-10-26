import type { D1Database } from "@cloudflare/workers-types";

/**
 * Total bytes of attachments stored on an account's statuses.
 *
 * The per-account storage quota (UPLOAD_QUOTA_BYTES) is checked on every
 * upload; uploads are rate-limited, so this single indexed sum stays bounded.
 * Pending uploads (`object_id = ''`) do not join to any object and are not
 * counted — the orphan sweep and their KV TTL bound those instead.
 */
export async function getAccountMediaUsage(db: D1Database, actorId: string): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(a.file_size), 0) AS bytes
           FROM attachments a JOIN objects o ON o.id = a.object_id
          WHERE o.actor_id = ?`
      )
      .bind(actorId)
      .first<{ bytes: number | null }>();
    return Number(row?.bytes ?? 0);
  } catch {
    return 0;
  }
}
