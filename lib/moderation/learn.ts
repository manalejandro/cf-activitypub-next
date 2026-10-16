/**
 * What the Guardian learns from a suspended account.
 *
 * A suspension is the instance's strongest confirmed-abuse signal, so **every**
 * suspension leaves a lesson in the vector memory (`rememberAbuse`): the
 * offending content the caller already has, a sample of the account's own
 * posts and its profile are embedded together, so the next account that posts
 * the same thing is caught by the content screening without a fresh model call
 * — and the pattern survives even when the suspension nulled the posts.
 *
 * The callers are the Guardian itself (content, account, report and
 * duplicate-spam decisions), a moderator suspending from `/admin/accounts` and
 * the registration sweep. A human or rule-based suspension carries no model
 * probability, so it is stored as a confirmed decision instead of being
 * skipped by the "no low confidence" rule.
 *
 * Best-effort by design: a missing AI/Vectorize binding or a failed embed never
 * breaks a moderation action.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { getActorById } from "@/lib/db";
import { buildAbuseVectorId, rememberAbuse } from "./vectors";

export interface LearnEnv {
  DB: D1Database;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
}

export interface SuspensionLesson {
  actorId: string;
  reason?: string | null;
  confidence?: string | null;
  model?: string | null;
  /** Offending text the caller already has (status, report evidence, sample). */
  content?: string | null;
}

/** How many of the account's posts are sampled into the lesson. */
const POST_SAMPLE = 5;
/** Hard cap on the lesson text (the embedding model truncates at 600 too). */
export const MAX_LESSON_CHARS = 600;
/** `rememberAbuse` ignores anything shorter (a bare username teaches nothing). */
const MIN_LESSON_CHARS = 12;

export interface SuspensionLessonResult {
  id: string;
  chars: number;
}

/**
 * Drop the lesson a suspension left behind. Lifting a suspension is a
 * correction, so the pattern must stop matching new content — otherwise a
 * mistake keeps auto-actioning whatever resembles it. Re-suspending learns it
 * again.
 */
export async function forgetSuspension(env: LearnEnv, actorId: string): Promise<boolean> {
  if (!env.VECTORIZE) return false;
  try {
    await env.VECTORIZE.deleteByIds([buildAbuseVectorId("account", actorId)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store what a suspended account was. Returns the stored vector id (null when
 * there was nothing to remember or the memory is unavailable).
 */
export async function learnFromSuspension(env: LearnEnv, lesson: SuspensionLesson): Promise<SuspensionLessonResult | null> {
  if (!env.AI || !env.VECTORIZE) return null;

  const actor = await getActorById(env.DB, lesson.actorId).catch(() => null);

  let posts: { content: string }[] = [];
  try {
    const rows = await env.DB
      .prepare(
        `SELECT content FROM objects
         WHERE actor_id = ? AND content IS NOT NULL AND content != ''
         ORDER BY published DESC LIMIT ?`
      )
      .bind(lesson.actorId, POST_SAMPLE)
      .all<{ content: string }>();
    posts = rows.results ?? [];
  } catch { /* missing table on an old DB — the profile alone still teaches */ }

  // The offending text leads (it is what the content screening will match);
  // the account's own posts and the profile follow so a silent spam account
  // still leaves a pattern behind.
  const profile = [actor?.username, actor?.displayName, actor?.summary].filter(Boolean).join(" ");
  const text = [lesson.content ?? "", ...posts.map((p) => p.content), profile]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_LESSON_CHARS);
  if (text.length < MIN_LESSON_CHARS) return null;

  const id = buildAbuseVectorId("account", lesson.actorId);
  const stored = await rememberAbuse(env, {
    id,
    kind: "account",
    action: "suspend",
    text,
    reason: lesson.reason ?? undefined,
    // A moderator's or a rule's suspension is a confirmed decision: it must not
    // be dropped by the "low confidence" filter that guards the AI's own calls.
    confidence: lesson.confidence && lesson.confidence !== "low" ? lesson.confidence : "high",
    model: lesson.model ?? "moderator",
  });
  return stored ? { id, chars: text.length } : null;
}
