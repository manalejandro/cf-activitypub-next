/**
 * AI decision engine — the "Guardian".
 *
 * Wraps clef (@cf/cloudflare/clef) behind the typed functions used by the
 * moderation pipeline. Clef returns probabilities for the options of each
 * question and never writes prose, so a verdict is assembled from three
 * answers: the `action` choice question, the probability of the chosen option
 * (verdict confidence) and the answered yes/no signals (the `reason`, written
 * in the instance language). All functions return null when the model is
 * unavailable or the answers are invalid, so callers never crash.
 *
 * The question schemas (policy, criteria, signals) live in ./prompts.ts.
 */

import { CLEF, confidenceFromProbability, pickChoice, runClef, signalsReason } from "./clef";
import {
  buildAccountDecision,
  buildContentDecision,
  buildRegistrationDecision,
  buildReportDecision,
  type DecisionSchema,
} from "./prompts";

export interface Verdict {
  action: string;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export type ReportVerdict = Verdict & { action: "dismiss" | "warn" | "delete" | "suspend" };
export type RegistrationVerdict = Verdict & { action: "approve" | "reject" };
export type ContentVerdict = Verdict & { action: "allow" | "mark_sensitive" | "delete" | "escalate" };
export type AccountVerdict = Verdict & { action: "monitor" | "warn" | "suspend" };

/** Model id used for audit logging. */
export const GUARDIAN_MODEL = String(CLEF).replace(/^@/, "");

interface AiEnv {
  AI?: Ai;
}

/**
 * Run a decision schema through clef and turn the answers into a verdict.
 * Returns null when the model is unavailable or the chosen action is not one
 * of the allowed ones (defensive: a model glitch must never widen the action
 * set).
 */
async function decide<T extends Verdict>(
  env: AiEnv,
  schema: DecisionSchema,
  allowedActions: string[]
): Promise<T | null> {
  if (!env.AI) return null;

  const answers = await runClef(env.AI, CLEF, schema.state, schema.questions);
  const action = pickChoice(answers, "action");
  if (!action || !allowedActions.includes(action.option)) return null;

  const reason = (
    signalsReason(answers, schema.signalLabels) ??
    schema.fallbackReasons[action.option] ??
    "Clasificado por el Guardian."
  ).slice(0, 500);

  return {
    action: action.option,
    reason,
    confidence: confidenceFromProbability(action.probability),
  } as T;
}

/** Evaluate a user report. */
export async function evaluateReport(
  env: AiEnv,
  report: {
    category: string;
    comment: string;
    statusContent: string;
    targetUsername: string;
    reporterUsername: string;
    invalidStatuses: boolean;
    mismatchedOwnership: boolean;
  }
): Promise<ReportVerdict | null> {
  return decide<ReportVerdict>(env, buildReportDecision(report), ["dismiss", "warn", "delete", "suspend"]);
}

/** Review a brand-new local account profile. */
export async function evaluateRegistration(
  env: AiEnv,
  profile: {
    username: string;
    displayName: string;
    summary: string;
    source: "web" | "api";
    ipSuspicious: boolean;
  }
): Promise<RegistrationVerdict | null> {
  return decide<RegistrationVerdict>(env, buildRegistrationDecision(profile), ["approve", "reject"]);
}

/** Screen individual status content. */
export async function evaluateContent(
  env: AiEnv,
  status: {
    content: string;
    contentWarning: string;
    mediaCount: number;
    isReply: boolean;
    visibility: string;
    authorUsername: string;
    accountAgeDays: number;
    statusesCount: number;
    previousWarnings: number;
    flags: string[];
    /** RAG precedent — confirmed-abuse cases semantically similar to this content. */
    precedent?: string | null;
  }
): Promise<ContentVerdict | null> {
  return decide<ContentVerdict>(env, buildContentDecision(status), ["allow", "mark_sensitive", "delete", "escalate"]);
}

/** Evaluate long-term account behavior. */
export async function evaluateAccount(
  env: AiEnv,
  account: {
    username: string;
    isLocal: boolean;
    domain: string;
    statusesCount: number;
    followersCount: number;
    followingCount: number;
    isBot: boolean;
    ageDays: number;
    postsLastHour: number;
    postsLastDay: number;
    linkRatio: number;
    followsLastHour: number;
    reportsReceived: number;
    previousWarnings: number;
    isSuspended: boolean;
    isVerified: boolean;
    flags: string[];
  }
): Promise<AccountVerdict | null> {
  return decide<AccountVerdict>(env, buildAccountDecision(account), ["monitor", "warn", "suspend"]);
}
