/**
 * Account expiration (inactivity).
 *
 * Enabled by default (12 months, configurable in /admin/settings, 0 disables):
 * a local account that has not signed in for the whole window is warned by
 * email **7 days** and again **24 hours** before expiring, suspended
 * automatically when the window passes, and finally deleted — federating
 * `Delete{Actor}` to its followers exactly like the owner's own self-delete —
 * one month after the suspension, without further warnings.
 *
 * `last_active_at` is maintained by `getAuthenticatedActor` (throttled to one
 * write per hour), so any authenticated request counts as activity; the warning
 * markers are dropped there too, so a returning user starts a fresh window.
 * Administrators and moderators are exempt: a privileged account must never be
 * removed by a background sweep.
 */

import type { D1Database, Queue, SendEmail } from "@cloudflare/workers-types";
import { getInstanceSetting, getActorById, deleteRemoteActorData } from "@/lib/db";
import { deleteLocalAccount, type DeletionR2 } from "@/lib/account-deletion";
import { sendAccountExpiryWarningEmail } from "@/lib/email";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import type { ModerationKV } from "./util";

export interface AccountExpirationEnv {
  DB: D1Database;
  /** Markers only: the expiration sweep never needs to read the values back. */
  KV?: ModerationKV & { delete?(key: string): Promise<unknown> };
  EMAIL?: SendEmail;
  FROM_EMAIL?: string;
  INSTANCE_TITLE?: string;
  INSTANCE_URL?: string;
  R2?: DeletionR2;
  DELIVERY_QUEUE?: Queue;
}

export interface ExpirationSettings {
  enabled: boolean;
  months: number;
}

export interface ExpirationResult {
  warned: number;
  warnedFinal: number;
  suspended: number;
  deleted: number;
}

/** Instance settings keys (also written by /api/v1/admin/instance_settings). */
export const EXPIRATION_ENABLED_KEY = "account_expiration_enabled";
export const EXPIRATION_MONTHS_KEY = "account_expiration_months";
export const DEFAULT_EXPIRATION_MONTHS = 12;
export const MIN_EXPIRATION_MONTHS = 1;
export const MAX_EXPIRATION_MONTHS = 120;
/** First warning: this many days before the expiry. */
export const EXPIRATION_WARNING_DAYS = 7;
/** Final warning: this many hours before the expiry. */
export const EXPIRATION_FINAL_WARNING_HOURS = 24;
/** Suspended accounts are purged this long after the suspension. */
export const SUSPENDED_PURGE_MONTHS = 1;

const CRON_COOLDOWN_SECONDS = 300;
const WARN_BATCH = 10;
const SUSPEND_BATCH = 20;
const PURGE_BATCH = 10;
/** Cached remote accounts carry whole timelines: purge them in smaller bites. */
const REMOTE_PURGE_BATCH = 5;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Effective settings (defaults: enabled, 12 months). */
export async function resolveExpirationSettings(db: D1Database): Promise<ExpirationSettings> {
  try {
    const [enabledRaw, monthsRaw] = await Promise.all([
      getInstanceSetting(db, EXPIRATION_ENABLED_KEY),
      getInstanceSetting(db, EXPIRATION_MONTHS_KEY),
    ]);
    const months = Number(monthsRaw);
    return {
      enabled: enabledRaw === null ? true : enabledRaw === "true",
      months: Number.isFinite(months) && months >= MIN_EXPIRATION_MONTHS
        ? Math.min(Math.round(months), MAX_EXPIRATION_MONTHS)
        : DEFAULT_EXPIRATION_MONTHS,
    };
  } catch {
    return { enabled: true, months: DEFAULT_EXPIRATION_MONTHS };
  }
}

/** The expiry of an account last active at `lastActive` (ISO), as ISO. */
export function expiryDate(lastActive: string, months: number): string {
  const date = new Date(lastActive);
  date.setMonth(date.getMonth() + months);
  return date.toISOString();
}

/** `now` shifted by whole (calendar) months, as ISO. */
function monthsAgoIso(months: number, now: number): string {
  const date = new Date(now);
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
}

/** Run one expiration pass (no throttling): warnings, suspension, purge. */
export async function sweepExpiredAccounts(env: AccountExpirationEnv): Promise<ExpirationResult> {
  const result: ExpirationResult = { warned: 0, warnedFinal: 0, suspended: 0, deleted: 0 };
  const settings = await resolveExpirationSettings(env.DB);
  if (!settings.enabled) return result;

  const now = Date.now();
  const suspendBefore = monthsAgoIso(settings.months, now);
  // "Warning N days before the expiry" ⇔ last access older than the window
  // minus N days.
  const warn7Before = new Date(new Date(suspendBefore).getTime() + EXPIRATION_WARNING_DAYS * DAY_MS).toISOString();
  const warn1Before = new Date(new Date(suspendBefore).getTime() + EXPIRATION_FINAL_WARNING_HOURS * HOUR_MS).toISOString();

  // Administrators/moderators are never touched by the background sweep, the
  // reserved instance actor (Guardian) is not an account, and an account
  // preserved in memoriam is never expired (that is the point of memorializing).
  const baseWhere =
    "is_local = 1 AND suspended = 0 AND role = 'user' AND COALESCE(reserved, 0) = 0 AND COALESCE(memorial, 0) = 0 AND last_active_at IS NOT NULL";

  // ── Warnings (7 days, then 24 hours before expiring) ──────────────────────
  // Both need the KV markers: without them the same account would be emailed on
  // every pass.
  if (env.KV && env.EMAIL && env.FROM_EMAIL) {
    const candidates = await env.DB
      .prepare(
        `SELECT id, username, email, last_active_at FROM actors
         WHERE ${baseWhere} AND email IS NOT NULL AND email_verified = 1
           AND datetime(last_active_at) <= datetime(?)
         ORDER BY last_active_at ASC LIMIT ?`
      )
      .bind(warn7Before, WARN_BATCH)
      .all<{ id: string; username: string; email: string; last_active_at: string }>();

    for (const row of candidates.results) {
      const lastActive = row.last_active_at;
      const final = lastActive <= warn1Before;
      const marker = `expiry:warn:${final ? 1 : 7}:${row.id}`;
      try {
        if (await env.KV.get(marker)) continue;
      } catch {
        continue;
      }
      const expiresAt = expiryDate(lastActive, settings.months);
      try {
        await sendAccountExpiryWarningEmail(env.EMAIL, {
          to: row.email,
          from: env.FROM_EMAIL,
          username: row.username,
          instanceTitle: env.INSTANCE_TITLE ?? "ActivityPub",
          instanceUrl: env.INSTANCE_URL ?? "",
          expiresAt,
          final,
        });
      } catch (err) {
        console.error(`[expiration] warning email for ${row.username} failed`, err);
        continue;
      }
      try {
        await env.KV.put(marker, "1", { expirationTtl: 60 * 24 * 3600 });
      } catch { /* the email went out; worst case it repeats once */ }
      if (final) result.warnedFinal += 1;
      else result.warned += 1;
    }
  }

  // ── Auto-suspension: the window passed without a sign-in ──────────────────
  const expiring = await env.DB
    .prepare(
      `SELECT id, username, email, last_active_at FROM actors
       WHERE ${baseWhere} AND datetime(last_active_at) <= datetime(?)
       ORDER BY last_active_at ASC LIMIT ?`
    )
    .bind(suspendBefore, SUSPEND_BATCH)
    .all<{ id: string; username: string; email: string | null; last_active_at: string }>();

  for (const row of expiring.results) {
    const updated = await env.DB
      .prepare(
        "UPDATE actors SET suspended = 1, suspended_at = ?, updated_at = datetime('now') WHERE id = ? AND suspended = 0"
      )
      .bind(new Date(now).toISOString(), row.id)
      .run();
    if (!updated.meta?.changes) continue;
    result.suspended += 1;
    await recordModeration(env, {
      id: generateId(),
      source: "heuristic",
      targetType: "account",
      targetId: row.id,
      action: "suspended",
      reason: `Inactividad: sin acceso desde ${row.last_active_at.slice(0, 10)} (caducidad de cuentas, ${settings.months} meses).`,
      confidence: "high",
      model: "expiration",
      details: { username: row.username, lastActiveAt: row.last_active_at, months: settings.months },
      emailSent: false,
      emailTo: row.email,
      relatedId: null,
    });
  }

  // ── Purge: suspended for a whole month (any suspension origin) ────────────
  // Both branches walk their own ordered index scan (a single query without the
  // `is_local` equality would lose `idx_actors_suspended_at`).
  const purgeBefore = monthsAgoIso(SUSPENDED_PURGE_MONTHS, now);
  const purgeableLocal = await env.DB
    .prepare(
      `SELECT id, username FROM actors
       WHERE is_local = 1 AND suspended = 1 AND COALESCE(reserved, 0) = 0 AND COALESCE(memorial, 0) = 0
         AND role = 'user' AND suspended_at IS NOT NULL
         AND datetime(suspended_at) <= datetime(?)
       ORDER BY suspended_at ASC LIMIT ?`
    )
    .bind(purgeBefore, PURGE_BATCH)
    .all<{ id: string; username: string }>();

  for (const row of purgeableLocal.results) {
    const actor = await getActorById(env.DB, row.id);
    if (!actor) continue;
    await deleteLocalAccount(
      {
        DB: env.DB,
        R2: env.R2,
        DELIVERY_QUEUE: env.DELIVERY_QUEUE,
        KV: env.KV,
      },
      actor,
      {
        reason: `Cuenta suspendida eliminada tras ${SUSPENDED_PURGE_MONTHS} mes(es) de suspensión (caducidad de cuentas).`,
        source: "heuristic",
        details: { username: row.username, suspendedAt: actor.suspendedAt ?? null },
      }
    );
    result.deleted += 1;
  }

  // Cached remote accounts are ours to drop: nothing is federated (we are the
  // ones who suspended them) and the canonical remote purge also subtracts the
  // follow counters and cleans the conversation pointers.
  const purgeableRemote = await env.DB
    .prepare(
      `SELECT id, username, domain FROM actors
       WHERE is_local = 0 AND suspended = 1 AND COALESCE(memorial, 0) = 0
         AND suspended_at IS NOT NULL
         AND datetime(suspended_at) <= datetime(?)
       ORDER BY suspended_at ASC LIMIT ?`
    )
    .bind(purgeBefore, REMOTE_PURGE_BATCH)
    .all<{ id: string; username: string; domain: string }>();

  for (const row of purgeableRemote.results) {
    await deleteRemoteActorData(env.DB, row.id);
    result.deleted += 1;
    await recordModeration(env, {
      id: generateId(),
      source: "heuristic",
      targetType: "account",
      targetId: row.id,
      action: "deleted",
      reason: `Cuenta remota suspendida eliminada de la caché tras ${SUSPENDED_PURGE_MONTHS} mes(es) de suspensión (caducidad de cuentas).`,
      confidence: "high",
      model: "expiration",
      details: { username: row.username, domain: row.domain },
      emailSent: false,
      emailTo: null,
      relatedId: null,
    });
  }

  return result;
}

/** Cron entry: throttled pass (a few minutes is plenty for day-scale windows). */
export async function runAccountExpiration(env: AccountExpirationEnv): Promise<void> {
  if (env.KV) {
    try {
      const last = await env.KV.get("cron:expiration:last");
      if (last && Date.now() - Number(last) < CRON_COOLDOWN_SECONDS * 1000) return;
      await env.KV.put("cron:expiration:last", String(Date.now()), { expirationTtl: 2 * CRON_COOLDOWN_SECONDS });
    } catch {
      // keep going when the marker cannot be written
    }
  }

  try {
    const result = await sweepExpiredAccounts(env);
    if (result.warned || result.warnedFinal || result.suspended || result.deleted) {
      console.log(
        `[expiration] warned ${result.warned}, final warnings ${result.warnedFinal}, suspended ${result.suspended}, deleted ${result.deleted}`
      );
    }
  } catch (err) {
    console.error("[expiration] sweep failed", err);
  }
}
