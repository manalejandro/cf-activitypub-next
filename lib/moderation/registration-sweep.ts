import type { D1Database, SendEmail } from "@cloudflare/workers-types";
import { emailDomain, isBlockedEmailDomain, registrationBlockedEmailDomains } from "@/lib/constants";
import { generateId } from "@/lib/activitypub/utils";
import { recordModeration } from "@/lib/moderation/log";
import type { ModerationKV } from "./util";
import { sendAdminAlertEmail } from "@/lib/email";

/**
 * Registration hygiene sweep.
 *
 * The bot waves that filled the instance registered from relay mailboxes (many
 * `user+tag@` variants of one mailbox) and never confirmed the email; the AI
 * pre-screen only *advised* on those signals, so the accounts stayed. This
 * sweep is deterministic (no AI neurons) and runs from the moderation cycle:
 *
 *  - silent/unconfirmed accounts on a blocked/disposable mail domain are
 *    suspended (accounts with a confirmed mailbox and normal activity are left
 *    to the AI screening),
 *  - accounts sharing one canonical mailbox with two more (a registration farm)
 *    are suspended,
 *  - silent accounts that never confirmed their email are deleted after a
 *    grace period (`UNVERIFIED_ACCOUNT_PURGE_DAYS`, default 7, 0 disables).
 *
 * Every action lands in `moderation_log` and the admins get a digest email.
 */

export interface RegistrationSweepEnv {
  DB: D1Database;
  KV?: ModerationKV;
  EMAIL?: SendEmail;
  FROM_EMAIL?: string;
  INSTANCE_TITLE?: string;
  INSTANCE_URL?: string;
  /** Days before a silent, never-confirmed account is deleted. 0 disables. */
  UNVERIFIED_ACCOUNT_PURGE_DAYS?: string;
  REGISTRATION_BLOCKED_EMAIL_DOMAINS?: string;
}

export interface RegistrationSweepResult {
  suspended: number;
  deleted: number;
  /** Usernames touched, for the admin digest. */
  usernames: string[];
}

const SWEEP_COOLDOWN_SECONDS = 300;
const ALERT_COOLDOWN_SECONDS = 3600;
const DEFAULT_UNVERIFIED_PURGE_DAYS = 7;
const MAX_SUSPENSIONS = 200;
const MAX_DELETIONS = 50;
/** How many local accounts the disposable-domain scan looks at. */
const DOMAIN_SCAN_LIMIT = 500;

/** Sweep once (no throttling): suspend farms/disposable domains, drop silence. */
export async function sweepAbusiveRegistrations(env: RegistrationSweepEnv): Promise<RegistrationSweepResult> {
  const result: RegistrationSweepResult = { suspended: 0, deleted: 0, usernames: [] };
  const blockedDomains = registrationBlockedEmailDomains(env as unknown as Record<string, unknown>);

  // ── Suspensions: disposable mail domains ────────────────────────────────
  // Only accounts with no confirmed identity or no sign of life: a real user
  // who confirmed an address on a throwaway-looking domain and posts normally
  // stays (the AI/status screening covers actual abuse).
  const localActors = await env.DB
    .prepare(
      `SELECT id, username, email FROM actors
       WHERE is_local = 1 AND suspended = 0 AND email IS NOT NULL
         AND (email_verified = 0
              OR (statuses_count = 0 AND followers_count = 0 AND following_count = 0))
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(DOMAIN_SCAN_LIMIT)
    .all<{ id: string; username: string; email: string }>();
  const disposable = localActors.results.filter((row) => isBlockedEmailDomain(emailDomain(row.email), blockedDomains));

  // ── Suspensions: mailbox farms (3+ accounts from one canonical mailbox) ──
  const farms = await env.DB
    .prepare(
      `SELECT a.id, a.username, a.email FROM actors a
       JOIN (
         SELECT canonical_email_hash AS h FROM actors
         WHERE is_local = 1 AND canonical_email_hash IS NOT NULL
         GROUP BY canonical_email_hash HAVING COUNT(*) >= 3
       ) f ON f.h = a.canonical_email_hash
       WHERE a.is_local = 1 AND a.suspended = 0
       LIMIT ?`
    )
    .bind(MAX_SUSPENSIONS)
    .all<{ id: string; username: string; email: string | null }>();

  const targets = new Map<string, { username: string; reason: string }>();
  for (const row of disposable) {
    targets.set(row.id, { username: row.username, reason: "Disposable email domain." });
  }
  for (const row of farms.results) {
    if (!targets.has(row.id)) {
      targets.set(row.id, { username: row.username, reason: "Registration farm from one mailbox." });
    }
  }

  for (const [id, info] of targets) {
    const updated = await env.DB
      .prepare("UPDATE actors SET suspended = 1, updated_at = datetime('now') WHERE id = ? AND suspended = 0")
      .bind(id)
      .run();
    if (!updated.meta?.changes) continue;
    result.suspended += 1;
    result.usernames.push(info.username);
    await recordModeration(env, {
      id: generateId(),
      source: "heuristic",
      targetType: "account",
      targetId: id,
      action: "suspended",
      reason: `Bot registration: ${info.reason.toLowerCase()}`,
      confidence: "high",
      model: "heuristic",
      details: { username: info.username, reason: info.reason },
      emailSent: false,
      emailTo: null,
      relatedId: null,
    });
  }

  // ── Deletions: never-confirmed accounts with no sign of life ─────────────
  const purgeDays = Number(env.UNVERIFIED_ACCOUNT_PURGE_DAYS ?? DEFAULT_UNVERIFIED_PURGE_DAYS);
  if (Number.isFinite(purgeDays) && purgeDays > 0) {
    const stale = await env.DB
      .prepare(
        `SELECT id, username FROM actors
         WHERE is_local = 1 AND email_verified = 0 AND suspended = 0
           AND datetime(created_at) < datetime('now', ?)
           AND statuses_count = 0 AND followers_count = 0 AND following_count = 0
         LIMIT ?`
      )
      .bind(`-${purgeDays} days`, MAX_DELETIONS)
      .all<{ id: string; username: string }>();

    for (const row of stale.results) {
      await env.DB.prepare("DELETE FROM oauth_tokens WHERE actor_id = ?").bind(row.id).run();
      await env.DB.prepare("DELETE FROM activities WHERE actor_id = ?").bind(row.id).run();
      await env.DB.prepare("DELETE FROM actors WHERE id = ?").bind(row.id).run();
      result.deleted += 1;
      result.usernames.push(row.username);
      await recordModeration(env, {
        id: generateId(),
        source: "heuristic",
        targetType: "account",
        targetId: row.id,
        action: "deleted",
        reason: `Unconfirmed account removed after ${purgeDays} days.`,
        confidence: "high",
        model: "heuristic",
        details: { username: row.username },
        emailSent: false,
        emailTo: null,
        relatedId: null,
      });
    }
  }

  return result;
}

/** Cron entry: throttle the sweep and email the admins a digest of what it did. */
export async function runRegistrationSweep(env: RegistrationSweepEnv): Promise<void> {
  if (env.KV) {
    try {
      const last = await env.KV.get("guardian:registration_sweep_last");
      if (last && Date.now() - Number(last) < SWEEP_COOLDOWN_SECONDS * 1000) return;
      await env.KV.put("guardian:registration_sweep_last", String(Date.now()), { expirationTtl: 2 * SWEEP_COOLDOWN_SECONDS });
    } catch {
      // keep going when the marker cannot be written
    }
  }

  const result = await sweepAbusiveRegistrations(env);
  if (result.suspended === 0 && result.deleted === 0) return;
  console.log(`[moderation] registration sweep: ${result.suspended} suspended, ${result.deleted} deleted`);
  await notifyAdmins(env, result).catch((err) => console.error("[moderation] admin digest failed", err));
}

async function notifyAdmins(env: RegistrationSweepEnv, result: RegistrationSweepResult): Promise<void> {
  if (!env.EMAIL || !env.FROM_EMAIL) return;
  if (env.KV) {
    try {
      const last = await env.KV.get("guardian:registration_alert_last");
      if (last && Date.now() - Number(last) < ALERT_COOLDOWN_SECONDS * 1000) return;
      await env.KV.put("guardian:registration_alert_last", String(Date.now()), { expirationTtl: 2 * ALERT_COOLDOWN_SECONDS });
    } catch {
      // still try to send
    }
  }

  const admins = await env.DB
    .prepare(
      `SELECT email FROM actors
       WHERE is_local = 1 AND role = 'admin' AND email_verified = 1
         AND suspended = 0 AND email IS NOT NULL`
    )
    .all<{ email: string }>();

  const lines = [
    `The registration sweep acted on ${result.suspended + result.deleted} account(s):`,
    "",
    `Suspended (bot registration signals): ${result.suspended}`,
    `Deleted (never confirmed, no activity): ${result.deleted}`,
    "",
    `Accounts: ${result.usernames.slice(0, 30).join(", ")}`,
    "",
    "Review them in /admin/suspended and /admin/moderation_log.",
  ];

  for (const admin of admins.results) {
    await sendAdminAlertEmail(env.EMAIL, {
      to: admin.email,
      from: env.FROM_EMAIL,
      subject: `[${env.INSTANCE_TITLE ?? "ActivityPub"}] ${result.suspended} suspended, ${result.deleted} deleted (bot sweep)`,
      lines,
    });
  }
}
