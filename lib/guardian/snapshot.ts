/**
 * The moderation picture the Guardian reports — used by its `instance_overview`
 * tool, by the agent's synced state (the admin panel renders it) and by the
 * callable refresh. One function so the panel and the model never disagree.
 */

import type { D1Database } from "@cloudflare/workers-types";

export interface GuardianSnapshot {
  accounts: { local: number; remote: number; suspended: number; limited: number };
  local_statuses_last_24h: number;
  open_reports: number;
  registrations_pending: number;
  moderation_decisions_last_24h: number;
  media_cache: { entries: number; bytes: number } | null;
}

export interface SnapshotEnv {
  DB: D1Database;
}

export async function getGuardianSnapshot(env: SnapshotEnv): Promise<GuardianSnapshot> {
  const [accounts, activity, reports, pending, decisions, cache] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN is_local = 1 THEN 1 ELSE 0 END) AS local_accounts,
         SUM(CASE WHEN is_local = 0 THEN 1 ELSE 0 END) AS remote_accounts,
         SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS suspended,
         SUM(CASE WHEN silenced = 1 AND suspended = 0 THEN 1 ELSE 0 END) AS limited
       FROM actors`
    ).first<Record<string, number>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS statuses FROM objects
        WHERE is_local = 1 AND published >= datetime('now', '-1 day')`
    ).first<{ statuses: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS open FROM reports WHERE action_taken = 0").first<{ open: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS pending FROM actors WHERE is_local = 1 AND (email_verified = 0 OR approved = 0) AND suspended = 0"
    ).first<{ pending: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM moderation_log WHERE created_at >= datetime('now', '-1 day')"
    ).first<{ n: number }>(),
    // The media cache is optional (the table exists everywhere, the cache may be off).
    env.DB.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(size), 0) AS bytes FROM media_cache WHERE status = 'ready'")
      .first<{ entries: number; bytes: number }>()
      .catch(() => null),
  ]);

  return {
    accounts: {
      local: Number(accounts?.local_accounts ?? 0),
      remote: Number(accounts?.remote_accounts ?? 0),
      suspended: Number(accounts?.suspended ?? 0),
      limited: Number(accounts?.limited ?? 0),
    },
    local_statuses_last_24h: Number(activity?.statuses ?? 0),
    open_reports: Number(reports?.open ?? 0),
    registrations_pending: Number(pending?.pending ?? 0),
    moderation_decisions_last_24h: Number(decisions?.n ?? 0),
    media_cache: cache ? { entries: Number(cache.entries ?? 0), bytes: Number(cache.bytes ?? 0) } : null,
  };
}
