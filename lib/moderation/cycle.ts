/**
 * Scheduled moderation cycle — the Guardian's routine patrol.
 *
 * Runs on the worker cron (every minute) and catches what slips past the
 * inline gates: scheduled posts, posts published while the AI was down,
 * spambots that only misbehave over time, repeated-content spam and
 * spammy remote domains. Every action goes through the audited engine.
 */

import { generateId } from "@/lib/activitypub/utils";
import { getActorById } from "@/lib/db";
import { evaluateAccount, GUARDIAN_MODEL } from "./ai";
import { contentHash, computeAccountSignals, computeContentSignals, hasAbuseSignals } from "./heuristics";
import { screenStatus } from "./pipeline";
import { warnAccount, suspendAccount, blockDomain, recordNoAction, type ModerationEnv } from "./actions";
import { recordModeration, countWarnings } from "./log";
import { isTrustedAuthor, chargeAI, chargeGlobalAI, AI_UNITS_REASON } from "./budget";

export interface GuardianCycleEnv extends ModerationEnv {
  KV?: KVNamespace;
}

const MIN_ACCOUNT_AGE = 10; // seconds — ignore accounts created milliseconds ago
/** How often the suspicious-account scan may run (KV cooldown, not every cron tick). */
const ACCOUNT_SCAN_COOLDOWN_SECONDS = 10 * 60;

/** Recent local statuses (published in the last N minutes). */
async function recentLocalStatuses(db: D1Database, minutes: number) {
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  return db
    .prepare(
      "SELECT id, actor_id, content, content_warning, sensitive, visibility, in_reply_to_id FROM objects WHERE is_local = 1 AND type = 'Note' AND published >= ? AND content IS NOT NULL AND content != '' ORDER BY published DESC LIMIT 40"
    )
    .bind(cutoff)
    .all<{ id: string; actor_id: string; content: string; content_warning: string | null; sensitive: number; visibility: string; in_reply_to_id: string | null }>();
}

/** Screen recently published local statuses (covers scheduled + AI downtime). */
async function screenRecentLocalStatuses(env: GuardianCycleEnv): Promise<void> {
  const rows = await recentLocalStatuses(env.DB, 20);
  for (const row of rows.results) {
    if (env.KV) {
      try {
        if (await env.KV.get(`guardian:status:${row.id}`)) continue;
        await env.KV.put(`guardian:status:${row.id}`, "1", { expirationTtl: 3600 });
      } catch {
        // best-effort marker — keep screening
      }
    }

    try {
      const author = await getActorById(env.DB, row.actor_id);
      if (!author) continue;
      const ageMs = Date.now() - new Date(author.createdAt).getTime();
      await screenStatus(env, {
        contentHtml: row.content,
        spoilerText: row.content_warning ?? "",
        mediaCount: 0,
        isReply: Boolean(row.in_reply_to_id),
        visibility: row.visibility,
        authorId: author.id,
        authorUsername: author.username,
        accountAgeDays: Number.isFinite(ageMs) ? Math.max(0, ageMs / 86400000) : 0,
        statusesCount: author.statusesCount,
        objectId: row.id,
      });
    } catch {
      // keep going
    }
  }
}

/** Accounts worth a behavior review: new, or following a lot without followers. */
async function reviewableAccounts(db: D1Database): Promise<{ id: string }[]> {
  const rows = await db
    .prepare(
      "SELECT id FROM actors WHERE (created_at >= datetime('now', '-1 day') OR (following_count >= 50 AND followers_count < 5)) AND suspended = 0 LIMIT 40"
    )
    .all<{ id: string }>();
  return rows.results;
}

/** Count an actor's statuses published after a cutoff (ISO string). */
async function countStatusesSince(db: D1Database, actorId: string, cutoffIso: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM objects WHERE actor_id = ? AND published >= ? AND type = 'Note'")
    .bind(actorId, cutoffIso)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** Review accounts showing suspicious behavior patterns. */
async function screenSuspiciousAccounts(env: GuardianCycleEnv): Promise<void> {
  // The candidate query scans the whole actors table, so gate the scan behind a
  // KV cooldown instead of running it on every cron tick. A KV failure must not
  // stop the scan (cooldown marker is best-effort).
  if (env.KV) {
    try {
      const lastScan = await env.KV.get("guardian:account_scan_last");
      if (lastScan && Date.now() - Number(lastScan) < ACCOUNT_SCAN_COOLDOWN_SECONDS * 1000) return;
      await env.KV.put("guardian:account_scan_last", String(Date.now()), { expirationTtl: 2 * 3600 });
    } catch {
      // keep scanning even if the cooldown marker cannot be written
    }
  }

  const candidates = await reviewableAccounts(env.DB);
  if (candidates.length === 0) return;

  const hourCutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const dayCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  for (const { id } of candidates) {
    if (env.KV && (await env.KV.get(`guardian:account:${id}`))) continue;
    if (env.KV) await env.KV.put(`guardian:account:${id}`, "1", { expirationTtl: 6 * 3600 });

    try {
      const actor = await getActorById(env.DB, id);
      if (!actor || actor.suspended) continue;

      const ageMs = Date.now() - new Date(actor.createdAt).getTime();
      const ageDays = Number.isFinite(ageMs) ? Math.max(0, ageMs / 86400000) : 0;
      if (ageMs < MIN_ACCOUNT_AGE * 1000) continue;

      const [postsLastHour, postsLastDay, followsLastHour, linkCount] = await Promise.all([
        countStatusesSince(env.DB, id, hourCutoff),
        countStatusesSince(env.DB, id, dayCutoff),
        env.DB
          .prepare("SELECT COUNT(*) AS c FROM follows WHERE actor_id = ? AND created_at >= datetime('now', '-1 hour')")
          .bind(id)
          .first<{ c: number }>(),
        env.DB
          .prepare("SELECT COUNT(*) AS c FROM objects WHERE actor_id = ? AND content LIKE '%http%' AND type = 'Note'")
          .bind(id)
          .first<{ c: number }>(),
      ]);

      const signals = computeAccountSignals({
        statusesCount: actor.statusesCount,
        followersCount: actor.followersCount,
        followingCount: actor.followingCount,
        ageDays,
        isBot: actor.isBot,
        postsLastHour,
        postsLastDay,
        linkStatuses: linkCount?.c ?? 0,
        followsLastHour: followsLastHour?.c ?? 0,
      });

      // Volume alone (many posts / many follows) is normal for legit users on
      // busy remote instances — it must never trigger a review on its own.
      // Only concrete abuse signals justify an expensive 70B review: content-
      // or behaviour-based flags, never pure volume counters. This also stops
      // the cron from burning the daily AI budget on every cached remote
      // account on each pass.
      if (!hasAbuseSignals(signals)) continue;

      // Without the AI binding there is no model to review the account with —
      // skip it rather than charging the daily budget for a review that can't
      // run. The heuristic-only stages (repeated spam, domains) still run.
      if (!env.AI) continue;

      // Respect the per-account AI budget — a burst of new accounts must not
      // drain the whole daily neuron allowance on 70B account reviews.
      const trusted = isTrustedAuthor({
        accountAgeDays: ageDays,
        statusesCount: actor.statusesCount,
        warnings: 0,
      });
      if (!(await chargeAI(env, id, trusted))) {
        await recordNoAction(env, {
          targetType: "account",
          targetId: id,
          action: "no_action",
          reason: "Presupuesto de IA diario agotado; revisión de cuenta omitida.",
          confidence: "low",
          source: "heuristic",
          model: "heuristic",
          details: { stage: "account_scan", signals: signals.flags },
        });
        continue;
      }

      if (!(await chargeGlobalAI(env, AI_UNITS_REASON))) {
        await recordNoAction(env, {
          targetType: "account",
          targetId: id,
          action: "no_action",
          reason: "Presupuesto global de IA diario agotado; revisión de cuenta omitida.",
          confidence: "low",
          source: "heuristic",
          model: "heuristic",
          details: { stage: "account_scan", signals: signals.flags },
        });
        continue;
      }

      const verdict = await evaluateAccount(env, {
        username: actor.username,
        isLocal: actor.isLocal,
        domain: actor.domain,
        statusesCount: actor.statusesCount,
        followersCount: actor.followersCount,
        followingCount: actor.followingCount,
        isBot: actor.isBot,
        ageDays,
        postsLastHour,
        postsLastDay,
        linkRatio: signals.linkRatio,
        followsLastHour: signals.followsLastHour,
        reportsReceived: 0,
        previousWarnings: 0,
        isSuspended: false,
        isVerified: actor.emailVerified,
        flags: signals.flags,
      });

      const details = { stage: "account_scan", signals: signals.flags, postsLastHour, postsLastDay, followsLastHour, linkRatio: signals.linkRatio };

      if (verdict?.action === "suspend" && verdict.confidence === "high") {
        await suspendAccount(env, { actorId: id, reason: verdict.reason, confidence: verdict.confidence, source: "ai", model: GUARDIAN_MODEL, details });
      } else if (verdict?.action === "warn" && verdict.confidence !== "low") {
        await warnAccount(env, { actorId: id, reason: verdict.reason, confidence: verdict.confidence, source: "ai", model: GUARDIAN_MODEL, details });
      } else if (verdict) {
        await recordNoAction(env, {
          targetType: "account",
          targetId: id,
          action: "no_action",
          reason: verdict.reason,
          confidence: verdict.confidence,
          source: "ai",
          model: GUARDIAN_MODEL,
          details,
        });
      }
    } catch {
      // keep going
    }
  }
}

/** Detect accounts repeatedly posting the same content (spambot signature). */
export async function detectRepeatedSpam(env: GuardianCycleEnv): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const rows = await env.DB
    .prepare("SELECT id, actor_id, content FROM objects WHERE type = 'Note' AND content IS NOT NULL AND content != '' AND published >= ? LIMIT 3000")
    .bind(cutoff)
    .all<{ id: string; actor_id: string; content: string }>();

  // Only content that looks like real spam can trigger an action. Repeating a
  // harmless message (a greeting, hashtags, a meme caption) many times is normal
  // human behaviour on busy instances — it must never be treated as a spambot.
  const groups = new Map<string, { actorId: string; count: number; sample: string }>();
  for (const row of rows.results) {
    const signals = computeContentSignals(row.content);
    const spamLike = signals.flags.some((f) =>
      f === "patron_estafa" ||
      f === "texto_casi_solo_enlaces" ||
      f === "muchos_enlaces" ||
      f === "mensaje_corto_con_enlace" ||
      f === "mayusculas_excesivas" ||
      f === "bot_spam_enlaces"
    );
    if (!spamLike) continue;

    const hash = contentHash(row.content);
    const key = `${row.actor_id}:${hash}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { actorId: row.actor_id, count: 1, sample: row.content });
    }
  }

  for (const [, g] of groups) {
    if (g.count < 5) continue;
    if (env.KV && (await env.KV.get(`guardian:spamdup:${g.actorId}`))) continue;
    if (env.KV) await env.KV.put(`guardian:spamdup:${g.actorId}`, "1", { expirationTtl: 24 * 3600 });

    try {
      const actor = await getActorById(env.DB, g.actorId);
      if (!actor || actor.suspended) continue;

      // Warn on the first pattern; suspend only once the account reoffends.
      const reason = `Publicación repetida ${g.count} veces en 24h con contenido tipo spam.`;
      const warnings = await countWarnings(env.DB, g.actorId);
      if (warnings >= 1) {
        await suspendAccount(env, {
          actorId: g.actorId,
          reason,
          confidence: "high",
          source: "heuristic",
          model: "heuristic",
          details: { stage: "duplicate_spam", count: g.count, sample: stripForDetails(g.sample) },
        });
      } else {
        await warnAccount(env, {
          actorId: g.actorId,
          reason,
          confidence: "medium",
          source: "heuristic",
          model: "heuristic",
          details: { stage: "duplicate_spam", count: g.count, sample: stripForDetails(g.sample) },
        });
      }
    } catch {
      // keep going
    }
  }
}

function stripForDetails(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Block domains that are a consistent source of abuse. */
export async function detectSpamDomains(env: GuardianCycleEnv): Promise<void> {
  const instanceDomain = (env.INSTANCE_URL ? new URL(env.INSTANCE_URL).hostname : "") || "localhost";

  // Only auto-block a domain when it is *overwhelmingly* spammy relative to how
  // many of its accounts we've cached — never just because a big server happens
  // to have a few spammers. Absolute count (>= 3) plus proportion (>= 50% of the
  // domain's cached accounts) prevents the collateral mass-suspension of a whole
  // legitimate instance (e.g. mastodon.social with 3 spam accounts out of 12k).
  const suspendedByDomain = await env.DB
    .prepare(
      `SELECT domain, SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS c
       FROM actors WHERE is_local = 0
       GROUP BY domain
       HAVING c >= 3 AND c * 1.0 / COUNT(*) >= 0.5`
    )
    .all<{ domain: string; c: number }>();

  const reportedByDomain = await env.DB
    .prepare(
      `SELECT a.domain, COUNT(DISTINCT r.id) AS c
       FROM reports r JOIN actors a ON a.id = r.target_id
       WHERE a.is_local = 0
       GROUP BY a.domain
       HAVING c >= 3 AND c >= 0.5 * (SELECT COUNT(*) FROM actors WHERE domain = a.domain AND is_local = 0)`
    )
    .all<{ domain: string; c: number }>();

  const domains = new Set<string>();
  for (const r of [...suspendedByDomain.results, ...reportedByDomain.results]) domains.add(r.domain);

  for (const domain of domains) {
    if (!domain || domain === instanceDomain) continue;
    const alreadyBlocked = await env.DB.prepare("SELECT id FROM domain_blocks WHERE domain = ? LIMIT 1").bind(domain).first();
    if (alreadyBlocked) continue;

    try {
      await blockDomain(env, {
        domain,
        instanceDomain,
        reason: "Dominio fuente de abuso (spam/suspensiones o reportes recurrentes).",
        confidence: "medium",
        source: "heuristic",
        model: "heuristic",
        details: { stage: "domain_scan" },
      });
      await recordModeration(env, {
        id: generateId(),
        source: "heuristic",
        targetType: "instance",
        targetId: null,
        action: "blocked_domain",
        reason: `Dominio ${domain} bloqueado por abuso recurrente.`,
        confidence: "medium",
        model: "heuristic",
        details: { stage: "domain_scan", domain },
        emailSent: false,
        emailTo: null,
        relatedId: null,
      });
    } catch {
      // keep going
    }
  }
}

/**
 * Full guardian patrol. Runs from the scheduled handler. Never throws.
 */
export async function runModerationCycle(env: GuardianCycleEnv): Promise<void> {
  // Never early-return when the AI binding is unavailable: the heuristic stages
  // (status screening, repeated-spam, domain blocking) take action without AI,
  // and the AI paths inside them already degrade to "no verdict". An early
  // `if (!env.AI) return` here silently disabled the whole cycle whenever the
  // AI binding misbehaved in production.

  // Each stage is isolated so one failure (DB, KV, AI) never silences the rest.
  await screenRecentLocalStatuses(env).catch((e) => console.error("[moderation] status screen failed", e));
  await screenSuspiciousAccounts(env).catch((e) => console.error("[moderation] account scan failed", e));
  await detectRepeatedSpam(env).catch((e) => console.error("[moderation] repeated spam failed", e));
  await detectSpamDomains(env).catch((e) => console.error("[moderation] domain scan failed", e));
}
