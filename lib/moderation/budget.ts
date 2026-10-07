/**
 * AI spend guard for the moderation pipeline.
 *
 * Workers AI neuron units are limited (typically ~10k/day on free plans), so we
 * must avoid spending a call on every status. This module implements two cheap,
 * KV-backed controls used by the pipeline:
 *
 *   1. Content-verdict cache — identical content from the same author reuses a
 *      stored decision instead of hitting the AI again.
 *   2. Per-account daily budget — a rolling count of AI calls charged per
 *      author; once exhausted, the pipeline falls back to heuristics only.
 *
 * Everything degrades gracefully: without KV, no limiting happens (local dev).
 */

import type { ModerationKV } from "./util";

export const TRUSTED_MIN_AGE_DAYS = 2;
export const TRUSTED_MIN_STATUSES = 5;
/** Expensive AI calls allowed per day for a new/low-trust account. */
export const BUDGET_NEW_ACCOUNT_MAX = 8;
/** Expensive AI calls allowed per day for a trusted account (flagged content only). */
export const BUDGET_TRUSTED_MAX = 3;
/** How long an identical-content verdict is reused. */
export const CACHE_TTL_SECONDS = 6 * 3600;
/** KV keys under which cache/budget entries are stored. */
const CACHE_KEY = "guardian:ch";
const BUDGET_KEY = "guardian:budget";
const GLOBAL_BUDGET_KEY = "guardian:gbudget";

/**
 * Relative neuron cost per AI call type, used by the global daily budget.
 * Coarse approximations — tune to match Workers AI pricing for your models.
 */
export const AI_UNITS_GUARD = 1;
export const AI_UNITS_VISION = 5;
export const AI_UNITS_REASON = 25;

export interface GlobalBudgetEnv {
  KV?: ModerationKV;
  /** Instance-wide daily AI budget in abstract units; unset/0 = unlimited. */
  AI_DAILY_BUDGET?: string | number;
}

/**
 * Charge `units` against the instance-wide daily AI budget.
 * Returns true when the call is allowed, false when today's budget is
 * exhausted. Degrades gracefully: no KV → no limiting (local dev); a budget
 * of 0/unset → unlimited.
 */
export async function chargeGlobalAI(env: GlobalBudgetEnv, units: number): Promise<boolean> {
  const raw = env.AI_DAILY_BUDGET;
  const budget = typeof raw === "string" ? Number(raw) : (raw ?? 0);
  if (!env.KV || !(budget > 0)) return true;

  const day = new Date().toISOString().slice(0, 10);
  const key = `${GLOBAL_BUDGET_KEY}:${day}`;
  try {
    const rawUsed = await env.KV.get(key);
    const used = rawUsed ? Number(rawUsed) : 0;
    if (!Number.isFinite(used) || used < 0) {
      await env.KV.put(key, String(units), { expirationTtl: 2 * 24 * 3600 });
      return true;
    }
    if (used + units > budget) return false;
    await env.KV.put(key, String(used + units), { expirationTtl: 2 * 24 * 3600 });
    return true;
  } catch {
    return true;
  }
}

export interface AuthorTrustInput {
  accountAgeDays: number;
  statusesCount: number;
  warnings: number;
}

/** Whether the author is trusted enough to skip the AI unless content is flagged. */
export function isTrustedAuthor(input: AuthorTrustInput): boolean {
  return (
    input.accountAgeDays >= TRUSTED_MIN_AGE_DAYS &&
    input.statusesCount >= TRUSTED_MIN_STATUSES &&
    input.warnings === 0
  );
}

export interface CachedContentVerdict {
  action: "allow" | "blocked" | "sensitive";
  reason?: string;
}

interface CacheEnv {
  KV?: ModerationKV;
}

/** Read a previously cached verdict for identical content from the same author. */
export async function getCachedContentVerdict(
  env: CacheEnv,
  authorId: string,
  hash: string
): Promise<CachedContentVerdict | null> {
  if (!env.KV) return null;
  try {
    const raw = await env.KV.get(`${CACHE_KEY}:${authorId}:${hash}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedContentVerdict;
    return parsed && typeof parsed.action === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Store a verdict so identical content from the same author skips the AI. */
export async function cacheContentVerdict(
  env: CacheEnv,
  authorId: string,
  hash: string,
  verdict: CachedContentVerdict
): Promise<void> {
  if (!env.KV) return;
  try {
    await env.KV.put(`${CACHE_KEY}:${authorId}:${hash}`, JSON.stringify(verdict), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch {
    // cache is best-effort
  }
}

/**
 * Charge one AI call against the author's daily budget.
 * Returns true when the call is allowed, false when the budget is exhausted.
 */
export async function chargeAI(
  env: CacheEnv,
  authorId: string,
  trusted: boolean
): Promise<boolean> {
  if (!env.KV) return true;
  const max = trusted ? BUDGET_TRUSTED_MAX : BUDGET_NEW_ACCOUNT_MAX;
  const key = `${BUDGET_KEY}:${authorId}`;
  const day = new Date().toISOString().slice(0, 10);

  try {
    const raw = await env.KV.get(key);
    let entry: { day: string; count: number } | null = null;
    if (raw) {
      try {
        entry = JSON.parse(raw) as { day: string; count: number };
      } catch {
        entry = null;
      }
    }

    if (!entry || entry.day !== day) {
      entry = { day, count: 0 };
    }

    if (entry.count >= max) return false;

    entry.count += 1;
    await env.KV.put(key, JSON.stringify(entry), { expirationTtl: 2 * 24 * 3600 });
    return true;
  } catch {
    return true;
  }
}
