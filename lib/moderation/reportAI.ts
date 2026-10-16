/**
 * Shared AI evaluation for report tickets.
 *
 * Runs the Guardian's report pipeline (heuristic pre-scan → LLM verdict → action)
 * so that locally-submitted reports and inbound federated Flag activities are
 * treated identically: every decision is audited in moderation_log and the
 * ticket is resolved/dismissed according to the verdict.
 */

import { getObjectById } from "@/lib/db";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { evaluateReport } from "./ai";
import {
  type ModerationEnv,
  suspendAccount,
  warnAccount,
  deleteStatus,
  resolveReport,
  dismissReport,
  recordNoAction,
} from "./actions";
import { GUARDIAN_MODEL } from "./ai";
import { sendReportOutcomeEmail } from "@/lib/email";
import { chargeGlobalAI, AI_UNITS_REASON } from "./budget";

export interface ReportAIInput {
  reportId: string;
  category: string;
  comment: string;
  /** Mastodon-encoded ids of the reported statuses (empty for account-only reports). */
  statusIds: string[];
  domain: string;
  target: { id: string; username: string };
  reporter: { id: string; username: string; email?: string | null };
}

/**
 * Evaluate a report with the Guardian and apply the verdict.
 *
 * Does not throw on model failures — those are recorded as no_action so the
 * scheduled moderation cycle / a human moderator can pick the ticket up.
 */
export async function evaluateReportWithAI(env: ModerationEnv, input: ReportAIInput): Promise<void> {
  const { reportId, category, comment, statusIds, domain, target, reporter } = input;
  const statusContents: string[] = [];
  const reviewedStatuses: string[] = [];
  let invalidStatuses = false;
  let mismatchedOwnership = false;
  let ownedStatuses = 0;

  for (const sid of statusIds) {
    const decoded = decodeStatusId(sid, domain);
    const obj = await getObjectById(env.DB, decoded);
    if (!obj) {
      invalidStatuses = true;
      continue;
    }
    if (obj.actorId !== target.id) {
      mismatchedOwnership = true;
    } else {
      ownedStatuses += 1;
    }
    reviewedStatuses.push(decoded);
    if (obj?.content) {
      const stripped = obj.content.replace(/<[^>]+>/g, "").trim();
      if (stripped) statusContents.push(stripped);
    }
  }

  const report = {
    category,
    comment,
    statusContent: statusContents.join("\n---\n").slice(0, 2000),
    targetUsername: target.username,
    reporterUsername: reporter.username,
    invalidStatuses,
    mismatchedOwnership,
  };

  // ── Heuristic pre-scan: the LLM is a last resort, not the first responder ──
  // Reports with nothing concrete to review are resolved without spending AI
  // neurons. A report whose statuses are all missing, or that points at statuses
  // belonging to someone else entirely, is handled deterministically.
  const allStatusesInvalid = statusIds.length > 0 && reviewedStatuses.length === 0;
  const allStatusesMismatched = reviewedStatuses.length > 0 && ownedStatuses === 0;
  const nothingToReview = statusContents.length === 0 && !(comment ?? "").trim();

  if (allStatusesInvalid) {
    await dismissReport(env, {
      reportId,
      reason: "Reporte descartado: ninguna de las publicaciones señaladas existe.",
      confidence: "high",
      source: "heuristic",
      model: "heuristic",
      details: { stage: "report_heuristic", reporterId: reporter.id, targetId: target.id, category, reviewedStatuses, invalidStatuses, mismatchedOwnership },
      relatedId: reporter.id,
    });
    return;
  }

  if (allStatusesMismatched) {
    await dismissReport(env, {
      reportId,
      reason: "Reporte descartado: las publicaciones señaladas no pertenecen a la cuenta denunciada.",
      confidence: "high",
      source: "heuristic",
      model: "heuristic",
      details: { stage: "report_heuristic", reporterId: reporter.id, targetId: target.id, category, reviewedStatuses, invalidStatuses, mismatchedOwnership },
      relatedId: reporter.id,
    });
    return;
  }

  if (nothingToReview) {
    await recordNoAction(env, {
      targetType: "report",
      targetId: reportId,
      action: "no_action",
      reason: "Reporte sin contenido sustancial que revisar; diferido para revisión manual.",
      confidence: "low",
      source: "heuristic",
      model: "heuristic",
      details: { stage: "report_heuristic", reporterId: reporter.id, targetId: target.id, category, reviewedStatuses, invalidStatuses, mismatchedOwnership },
      relatedId: reporter.id,
    });
    return;
  }

  if (!(await chargeGlobalAI(env, AI_UNITS_REASON))) {
    await recordNoAction(env, {
      targetType: "report",
      targetId: reportId,
      action: "no_action",
      reason: "Presupuesto global de IA diario agotado; reporte diferido.",
      confidence: "low",
      source: "heuristic",
      model: "heuristic",
      details: { stage: "report", reporterId: reporter.id, targetId: target.id, category, reviewedStatuses, invalidStatuses, mismatchedOwnership },
      relatedId: reporter.id,
    });
    return;
  }

  const verdict = await evaluateReport(env, report);

  if (!verdict || verdict.confidence === "low") {
    // Leave open for the scheduled moderation cycle / keep an audit trail.
    await recordNoAction(env, {
      targetType: "report",
      targetId: reportId,
      action: "no_action",
      reason: verdict?.reason ?? "Reporte no evaluado (IA no disponible o confianza baja).",
      confidence: verdict?.confidence,
      source: "ai",
      model: GUARDIAN_MODEL,
      details: { stage: "report", reporterId: reporter.id, targetId: target.id, category, reviewedStatuses, invalidStatuses, mismatchedOwnership },
      relatedId: reporter.id,
    });
    return;
  }

  const evidence = statusContents.join("\n---\n").slice(0, 1000);
  const details = { stage: "report", reporterId: reporter.id, targetId: target.id, category, reviewedStatuses, invalidStatuses, mismatchedOwnership, statusContent: evidence, content: evidence };
  let actionNote = `[AI] Decisión: ${verdict.action}. Razón: ${verdict.reason} (confianza: ${verdict.confidence})`;

  if (verdict.action === "suspend") {
    await suspendAccount(env, {
      actorId: target.id,
      reason: verdict.reason,
      confidence: verdict.confidence,
      source: "ai",
      model: GUARDIAN_MODEL,
      details,
      relatedId: reportId,
    });
    actionNote += " — Cuenta suspendida.";
  } else if (verdict.action === "delete") {
    for (const oid of reviewedStatuses) {
      await deleteStatus(env, {
        objectId: oid,
        reason: verdict.reason,
        confidence: verdict.confidence,
        source: "ai",
        model: GUARDIAN_MODEL,
        details,
        relatedId: reportId,
      });
    }
    actionNote += " — Publicación(es) eliminada(s).";
  } else if (verdict.action === "warn") {
    await warnAccount(env, {
      actorId: target.id,
      reason: verdict.reason,
      confidence: verdict.confidence,
      source: "ai",
      model: GUARDIAN_MODEL,
      details,
      relatedId: reportId,
    });
    actionNote += " — Advertencia emitida.";
  } else {
    // dismiss — the report is fraudulent/unfounded
    await dismissReport(env, {
      reportId,
      reason: verdict.reason,
      confidence: verdict.confidence,
      source: "ai",
      model: GUARDIAN_MODEL,
      details,
      relatedId: reporter.id,
    });
    actionNote += " — Reporte descartado.";
  }

  // Mark the report resolved (unless already dismissed/removed).
  if (verdict.action !== "dismiss") {
    await resolveReport(env, {
      reportId,
      note: actionNote,
      reason: verdict.reason,
      confidence: verdict.confidence,
      source: "ai",
      model: GUARDIAN_MODEL,
      details,
      relatedId: reporter.id,
    });
  }

  // Notify the reporter about the outcome.
  if (reporter.email && env.EMAIL) {
    try {
      await sendReportOutcomeEmail(env.EMAIL, {
        to: reporter.email,
        from: env.FROM_EMAIL ?? "",
        reporterUsername: reporter.username,
        targetUsername: target.username,
        action: verdict.action,
        reason: verdict.reason,
        instanceTitle: env.INSTANCE_TITLE ?? "",
      });
    } catch {
      // email error — don't fail the report
    }
  }
}