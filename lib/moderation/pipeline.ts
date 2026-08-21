/**
 * Shared content-screening pipeline used by BOTH the pre-publish gate
 * (app/api/v1/statuses) and the scheduled moderation cycle (src/worker.ts).
 *
 * Cost-aware pyramid (Workers AI neurons are a limited daily budget):
 *
 *   Tier 0 (free)       Deterministic signals + author trust + KV content-hash
 *                       cache. Clean content from a trusted author → allow with
 *                       ZERO AI calls. Identical content already reviewed →
 *                       reuse the stored verdict.
 *   Tier 1 (cheap)      Llama Guard 8B fast screen + Vectorize similarity.
 *   Tier 2 (expensive)  Reasoning model (70B) — only when Tier 1 flags content
 *                       or the author has a behavior review flag.
 *
 * A per-account daily budget (KV) caps how many times any AI tier may run for a
 * given author; once exhausted the pipeline falls back to heuristics only.
 * An instance-wide daily budget (AI_DAILY_BUDGET, KV) additionally disables the
 * AI tiers for the whole server once the day's neuron allowance is spent.
 */

import { screenContent } from "./classifier";
import { evaluateContent } from "./ai";
import { stripHtml, computeContentSignals, contentHash } from "./heuristics";
import { vectorPreScreen } from "./vectors";
import { warnAccount, suspendAccount, deleteStatus, markStatusSensitive, recordNoAction, GUARDIAN_MODEL } from "./actions";
import { countWarnings } from "./log";
import { isTrustedAuthor, getCachedContentVerdict, cacheContentVerdict, chargeAI, chargeGlobalAI, AI_UNITS_GUARD, AI_UNITS_REASON } from "./budget";
import { runWithTimeout } from "./util";
import type { ModerationEnv } from "./actions";

/** Guard categories that are severe enough to block even without a verdict. */
const SEVERE_GUARD_CODES = new Set(["S1", "S2", "S3", "S4", "S10", "S11"]);
/** Categories that only warrant marking the content sensitive. */
const SENSITIVE_GUARD_CODES = new Set(["S12"]);

/**
 * Heuristic flags strong enough to act on directly, without an LLM call.
 * Deliberately conservative: only unmistakable spam patterns and content that
 * is essentially nothing but links. Softer signals (muchos_enlaces,
 * mensaje_corto_con_enlace, mayusculas, emoji) still go to the cheap Llama
 * Guard screen rather than auto-blocking a possibly-legitimate post.
 *
 * `patron_estafa` is a keyword match (crypto, work-from-home, ...) that a
 * trusted user could legitimately discuss, so it only auto-blocks new/low-trust
 * accounts; `texto_casi_solo_enlaces` is structural (content is just links) and
 * blocks regardless of trust.
 */
const STRONG_SPAM_FLAGS = new Set(["patron_estafa", "texto_casi_solo_enlaces"]);

export interface ScreenStatusInput {
  contentHtml: string;
  spoilerText: string;
  mediaCount: number;
  isReply: boolean;
  visibility: string;
  authorId: string;
  authorUsername: string;
  accountAgeDays: number;
  statusesCount: number;
  /** null when the status has not been created yet (pre-publish gate). */
  objectId: string | null;
}

export interface ScreenStatusOutput {
  blocked: boolean;
  markedSensitive: boolean;
  reason?: string;
}

export async function screenStatus(
  env: ModerationEnv,
  input: ScreenStatusInput
): Promise<ScreenStatusOutput> {
  const plainText = stripHtml(input.contentHtml);
  if (!plainText) return { blocked: false, markedSensitive: false };

  // ── Tier 0: free deterministic signals + trust + KV cache ──────────────────
  const signals = computeContentSignals(input.contentHtml);
  const hash = contentHash(plainText);
  const previousWarnings = await countWarnings(env.DB, input.authorId);
  const trusted = isTrustedAuthor({
    accountAgeDays: input.accountAgeDays,
    statusesCount: input.statusesCount,
    warnings: previousWarnings,
  });

  // Same author, identical content, already reviewed → reuse the verdict.
  const cached = await getCachedContentVerdict(env, input.authorId, hash);
  if (cached) {
    if (cached.action === "blocked") {
      await warnOrSuspend(env, input, previousWarnings, cached.reason ?? "Contenido bloqueado.", "high", "heuristic");
      if (input.objectId) {
        await deleteStatus(env, { objectId: input.objectId, reason: cached.reason ?? "Contenido bloqueado.", confidence: "high", source: "heuristic", model: "heuristic", details: { stage: "cached_verdict" } });
      }
      return { blocked: true, markedSensitive: false, reason: cached.reason };
    }
    if (cached.action === "sensitive") {
      if (input.objectId) {
        await markStatusSensitive(env, {
          objectId: input.objectId,
          spoilerText: input.spoilerText || "Contenido sensible",
          reason: cached.reason ?? "Contenido marcado como sensible.",
          confidence: "high",
          source: "heuristic",
          model: "heuristic",
          details: { stage: "cached_verdict" },
        });
      }
      return { blocked: false, markedSensitive: true };
    }
    // Cached "allow": the original review already logged the outcome, so the
    // re-scan (scheduled cycle) is a silent no-op instead of spamming the log.
    return { blocked: false, markedSensitive: false };
  }

  // Clean content from a trusted author → allow with zero AI calls.
  if (trusted && signals.flags.length === 0) {
    await cacheContentVerdict(env, input.authorId, hash, { action: "allow" });
    await recordNoAction(env, {
      targetType: "status",
      targetId: input.objectId,
      action: "no_action",
      reason: "Revisado por heurísticas (autor de confianza, sin señales).",
      confidence: "high",
      source: "heuristic",
      model: "heuristic",
      details: {
        stage: "trusted_allow",
        authorId: input.authorId,
        authorUsername: input.authorUsername,
        objectId: input.objectId,
        content: plainText.slice(0, 300),
        flags: signals.flags,
      },
      relatedId: input.authorId,
    });
    return { blocked: false, markedSensitive: false };
  }

  const details: {
    stage: string;
    authorId: string;
    objectId: string | null;
    flags: string[];
    content: string;
    guardCategories?: string[];
    vectorMatch?: { id: string; kind: string; action: string; score: number } | null;
  } = {
    stage: input.objectId ? "scheduled_scan" : "content_gate",
    authorId: input.authorId,
    objectId: input.objectId,
    flags: signals.flags,
    content: plainText.slice(0, 300),
  };

  // ── Tier 0.5: heuristic auto-action — the LLM is a last resort, not the
  // first responder. Unmistakable spam signals are acted on here directly,
  // without spending a single neuron unit.
  const strongSpam = signals.flags.some((f) => STRONG_SPAM_FLAGS.has(f)) && (!trusted || signals.flags.includes("texto_casi_solo_enlaces"));
  if (strongSpam) {
    const reason = `Contenido detectado como spam por heurísticas (${signals.flags.join(", ")}).`;
    await cacheContentVerdict(env, input.authorId, hash, { action: "blocked", reason });
    await warnOrSuspend(env, input, previousWarnings, reason, "high", "heuristic");
    if (input.objectId) {
      await deleteStatus(env, { objectId: input.objectId, reason, confidence: "high", source: "heuristic", model: "heuristic", details });
    }
    return { blocked: true, markedSensitive: false, reason };
  }

  // Clean content from an unknown/new author that contains no links and no
  // other flag needs no AI either — allow on heuristics alone.
  if (signals.flags.length === 0 && signals.links === 0) {
    await cacheContentVerdict(env, input.authorId, hash, { action: "allow" });
    await recordNoAction(env, {
      targetType: "status",
      targetId: input.objectId,
      action: "no_action",
      reason: "Revisado por heurísticas (sin señales ni enlaces).",
      confidence: "high",
      source: "heuristic",
      model: "heuristic",
      details,
      relatedId: input.authorId,
    });
    return { blocked: false, markedSensitive: false };
  }

  // ── AI budget gate: cap per-account AI spend per day ───────────────────────
  // Suspicious authors still get a generous allowance; once spent, we fall back
  // to heuristics only (nothing is blocked/actioned purely by the LLM anymore).
  const hasBudget = await chargeAI(env, input.authorId, trusted);
  if (!hasBudget) {
    await cacheContentVerdict(env, input.authorId, hash, { action: "allow" });
    await recordNoAction(env, {
      targetType: "status",
      targetId: input.objectId,
      action: "no_action",
      reason: "Presupuesto de IA diario agotado; permitido por heurísticas.",
      confidence: "low",
      source: "heuristic",
      model: "heuristic",
      details,
      relatedId: input.authorId,
    });
    return { blocked: false, markedSensitive: false };
  }

  // ── Tier 1: cheap Llama Guard screen + Vectorize similarity in parallel ────
  const globalOk = await chargeGlobalAI(env, AI_UNITS_GUARD);
  const [screen, vector] = await Promise.all([
    env.AI && globalOk ? runWithTimeout(screenContent(env.AI, plainText), 2500, null) : Promise.resolve(null),
    vectorPreScreen(env, plainText),
  ]);

  if (vector.flagged) signals.flags.push("similar_confirmed_spam");

  details.guardCategories = screen?.categories ?? [];
  details.vectorMatch = vector.best
    ? { id: vector.best.id, kind: vector.best.kind, action: vector.best.action, score: Number(vector.best.score.toFixed(4)) }
    : null;

  // 2. Auto-action: this content is a near-duplicate of previously confirmed
  //    abuse — reuse the stored decision instead of re-asking the model.
  if (vector.autoAction && vector.best) {
    const reason = `Contenido casi idéntico a abuso confirmado previamente (similitud ${vector.best.score.toFixed(2)}): ${vector.best.reason ?? "spam conocido"}`.slice(0, 500);
    await cacheContentVerdict(env, input.authorId, hash, { action: "blocked", reason });

    if (vector.autoAction === "suspend") {
      await suspendAccount(env, { actorId: input.authorId, reason, confidence: "high", source: "ai", model: GUARDIAN_MODEL, details });
      if (input.objectId) {
        await deleteStatus(env, { objectId: input.objectId, reason, confidence: "high", source: "ai", model: GUARDIAN_MODEL, details });
      }
      return { blocked: true, markedSensitive: false, reason };
    }

    if (vector.autoAction === "delete") {
      await warnOrSuspend(env, input, previousWarnings, reason, "high", "ai");
      if (input.objectId) {
        await deleteStatus(env, { objectId: input.objectId, reason, confidence: "high", source: "ai", model: GUARDIAN_MODEL, details });
      }
      return { blocked: true, markedSensitive: false, reason };
    }

    // "reject" precedents are registration-specific; nothing to do here.
  }

  // 3. Guard fast screen: nothing flagged and no vector signal → allow.
  //    Log the outcome (the AI being unavailable makes `screen` null, and
  //    without this entry those statuses would silently disappear from the
  //    moderation log).
  if (!screen || screen.safe) {
    if (!vector.flagged) {
      await cacheContentVerdict(env, input.authorId, hash, { action: "allow" });
      await recordNoAction(env, {
        targetType: "status",
        targetId: input.objectId,
        action: "no_action",
        reason: screen
          ? "Revisado por el filtro de seguridad (sin señales)."
          : "Revisado sin modelo de IA disponible (sin señales).",
        confidence: "high",
        source: "heuristic",
        model: "heuristic",
        details,
        relatedId: input.authorId,
      });
      return { blocked: false, markedSensitive: false };
    }
    // Only a moderate vector signal — let the reasoning model decide.
  }

  const guardCodes = new Set(screen ? screen.categories.map((c) => c.split(":")[0].trim().toUpperCase()) : []);
  const severe = [...guardCodes].some((c) => SEVERE_GUARD_CODES.has(c));

  // ── Tier 2: expensive reasoning model — only for actually-flagged content ──
  const globalReasonOk = await chargeGlobalAI(env, AI_UNITS_REASON);
  const verdict = globalReasonOk
    ? await runWithTimeout(
        evaluateContent(env, {
          content: plainText.slice(0, 1200),
          contentWarning: input.spoilerText,
          mediaCount: input.mediaCount,
          isReply: input.isReply,
          visibility: input.visibility,
          authorUsername: input.authorUsername,
          accountAgeDays: input.accountAgeDays,
          statusesCount: input.statusesCount,
          previousWarnings,
          flags: signals.flags,
          precedent: vector.precedent,
        }),
        6000,
        null
      )
    : null;

  const action = verdict?.action ?? (severe ? "delete" : [...guardCodes].some((c) => SENSITIVE_GUARD_CODES.has(c)) ? "mark_sensitive" : "allow");

  if (action === "delete") {
    const reason = verdict?.reason ?? "Contenido clasificado como grave por el filtro de seguridad.";
    const confidence = verdict?.confidence ?? "high";
    await cacheContentVerdict(env, input.authorId, hash, { action: "blocked", reason });
    await warnOrSuspend(env, input, previousWarnings, reason, confidence, "ai");
    if (input.objectId) {
      await deleteStatus(env, { objectId: input.objectId, reason, confidence, source: "ai", model: GUARDIAN_MODEL, details });
    }
    return { blocked: true, markedSensitive: false, reason };
  }

  if (action === "mark_sensitive") {
    const reason = verdict?.reason ?? "Contenido marcado como sensible.";
    await cacheContentVerdict(env, input.authorId, hash, { action: "sensitive", reason });
    if (input.objectId) {
      await markStatusSensitive(env, {
        objectId: input.objectId,
        spoilerText: input.spoilerText || "Contenido sensible",
        reason,
        confidence: verdict?.confidence ?? "medium",
        source: "ai",
        model: GUARDIAN_MODEL,
        details,
      });
    } else {
      await recordNoAction(env, {
        targetType: "status",
        targetId: null,
        action: "marked_sensitive",
        reason,
        confidence: verdict?.confidence ?? "medium",
        source: "ai",
        model: GUARDIAN_MODEL,
        details,
        relatedId: input.authorId,
      });
    }
    return { blocked: false, markedSensitive: true };
  }

  // allow / escalate / reasoning unavailable but not severe → proceed.
  await cacheContentVerdict(env, input.authorId, hash, { action: "allow" });
  await recordNoAction(env, {
    targetType: "status",
    targetId: input.objectId,
    action: "no_action",
    reason: verdict?.reason ?? "Revisado y permitido.",
    confidence: verdict?.confidence,
    source: "ai",
    model: GUARDIAN_MODEL,
    details,
    relatedId: input.authorId,
  });

  return { blocked: false, markedSensitive: false };
}

/** Warn on first offence, suspend on repeat — shared by the blocking paths. */
async function warnOrSuspend(
  env: ModerationEnv,
  input: ScreenStatusInput,
  previousWarnings: number,
  reason: string,
  confidence: "low" | "medium" | "high",
  source: "ai" | "heuristic"
): Promise<void> {
  if (previousWarnings >= 1) {
    await suspendAccount(env, { actorId: input.authorId, reason, confidence, source, model: "heuristic", details: { stage: "pipeline" } });
  } else {
    await warnAccount(env, { actorId: input.authorId, reason, confidence, source, model: "heuristic", details: { stage: "pipeline" } });
  }
}
