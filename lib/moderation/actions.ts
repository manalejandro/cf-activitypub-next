/**
 * Moderation action engine — the DB mutations the Guardian is allowed to make,
 * each wrapped with audit logging and optional owner notification emails.
 *
 * These functions are the only place where the moderation system writes to the
 * database, so every action is traceable through moderation_log.
 */

import { generateId, actorIRI } from "@/lib/activitypub/utils";
import { broadcastActorState } from "@/lib/activitypub/actor-update";
import { generateKeyPair } from "@/lib/activitypub/security";
import { createActor, getActorById, getActorByUsername, getObjectById } from "@/lib/db";
import { sendModerationNoticeEmail, type ModerationNoticeAction } from "@/lib/email";
import { notify, type NotifyEnv } from "@/lib/notify";
import { recordModeration, hadAction, type ModerationSource } from "./log";
import type { ModerationKV } from "./util";
import { GUARDIAN_MODEL } from "./ai";
import { rememberAbuse, buildAbuseVectorId } from "./vectors";
import { forgetSuspension, learnFromSuspension } from "./learn";
import { stripHtml } from "./heuristics";
import type { LocalActor } from "@/lib/types";

export interface ModerationEnv {
  DB: D1Database;
  DELIVERY_QUEUE?: Queue;
  AI?: Ai;
  EMAIL?: SendEmail;
  KV?: ModerationKV;
  VECTORIZE?: VectorizeIndex;
  INSTANCE_TITLE?: string;
  INSTANCE_URL?: string;
  FROM_EMAIL?: string;
  /** Instance-wide daily AI budget in abstract units; unset/0 = unlimited. */
  AI_DAILY_BUDGET?: string | number;
}

export interface ActionResult {
  action: string;
  applied: boolean;
  emailSent: boolean;
  reason?: string;
}

interface ActionBase {
  reason?: string;
  confidence?: "low" | "medium" | "high";
  source?: ModerationSource;
  model?: string;
  details?: Record<string, unknown>;
  relatedId?: string | null;
}

const SYSTEM = "system" as ModerationSource;

/** Default audit metadata for AI-driven actions. */
function meta(base: ActionBase, source: ModerationSource, model?: string): Required<Pick<ActionBase, "source" | "model">> {
  return {
    source: base.source ?? source,
    model: base.model ?? model ?? "heuristic",
  };
}

/**
 * The Guardian is represented by a reserved local admin account so domain
 * blocks (whose schema requires an actor_id FK) and future bot behaviour have a
 * stable identity. Created lazily on first use.
 */
export async function ensureGuardianActor(env: ModerationEnv, domain: string): Promise<string | null> {
  try {
    const existing = await getActorByUsername(env.DB, "guardian", domain);
    if (existing) {
      // Self-heal: a row created before `reserved` existed would be a normal
      // admin account that anyone could suspend or demote.
      if (!existing.reserved || existing.role !== "admin") {
        await env.DB
          .prepare("UPDATE actors SET role = 'admin', reserved = 1, discoverable = 0 WHERE id = ?")
          .bind(existing.id)
          .run();
      }
      return existing.id;
    }

    const { publicKeyPem, privateKeyPem } = await generateKeyPair();
    const id = actorIRI(`https://${domain}`, "guardian");
    await createActor(env.DB, {
      id,
      username: "guardian",
      domain,
      displayName: "Guardian",
      summary: "Sistema automático de moderación de la instancia.",
      avatarUrl: null,
      headerUrl: null,
      publicKeyPem,
      privateKeyPem,
      isLocal: true,
      isBot: true,
      manuallyApprovesFollowers: false,
      discoverable: false,
      followersCount: 0,
      followingCount: 0,
      statusesCount: 0,
      email: null,
      passwordHash: null,
      emailVerified: true,
      autoDeleteAfter: null,
    });
    await env.DB
      .prepare("UPDATE actors SET role = 'admin', reserved = 1, discoverable = 0 WHERE id = ?")
      .bind(id)
      .run();
    return id;
  } catch {
    return null;
  }
}

/**
 * The reserved instance actor (the Guardian) is never a moderation target: it
 * is the instance's own bot, it has no owner to notify, and suspending,
 * silencing or deleting it would disarm the instance's moderation. The admin
 * routes refuse it through `accountActionGuard`; this is the same rule for the
 * Guardian's own decisions, which act without a human in the loop (an inbound
 * report or a patrol verdict must not be able to turn the bot off).
 */
async function refuseProtectedTarget(
  env: ModerationEnv,
  actor: LocalActor,
  attempted: string,
  opts: ActionBase
): Promise<void> {
  await recordNoAction(env, {
    targetType: "account",
    targetId: actor.id,
    action: "no_action",
    reason: "La cuenta reservada de la instancia (Guardian) no puede ser moderada.",
    source: opts.source ?? "system",
    model: opts.model ?? "system",
    details: { stage: "protected_account", attempted, ...(opts.details ?? {}) },
  });
}

/** Try to email the owner of an account about a moderation action. */
export async function notifyAccountOwner(
  env: ModerationEnv,
  actor: { email: string | null; username: string; isLocal: boolean; domain: string },
  action: ModerationNoticeAction,
  reason: string
): Promise<boolean> {
  if (!actor.email || !actor.isLocal) return false;
  if (!env.EMAIL || !env.FROM_EMAIL) return false;
  try {
    await sendModerationNoticeEmail(env.EMAIL, {
      to: actor.email,
      from: env.FROM_EMAIL,
      username: actor.username,
      action,
      reason: reason ?? "Infracción de las normas de la comunidad.",
      instanceTitle: env.INSTANCE_TITLE ?? "la instancia",
      instanceUrl: env.INSTANCE_URL ?? `https://${actor.domain}`,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell a local account that a report was filed against it: an in-app
 * `moderation` notification (always) plus a throttled email. The notification
 * comes from the reserved Guardian account, never from the reporter, so the
 * reported user cannot identify or retaliate against whoever filed it. The
 * email is limited to one per account per day so a report flood cannot be used
 * to mail-bomb a target.
 */
export async function notifyReportedAccount(
  env: ModerationEnv & NotifyEnv,
  opts: { actorId: string; reporterId?: string | null }
): Promise<void> {
  try {
    const target = await getActorById(env.DB, opts.actorId);
    if (!target || !target.isLocal || target.suspended) return;
    if (opts.reporterId && opts.reporterId === target.id) return;

    let domain = target.domain;
    try {
      if (env.INSTANCE_URL) domain = new URL(env.INSTANCE_URL).hostname;
    } catch { /* keep the actor's own domain */ }
    const guardianId = await ensureGuardianActor(env, domain);
    if (!guardianId || guardianId === target.id) return;

    await notify(env, {
      id: generateId(),
      type: "moderation",
      accountId: guardianId,
      targetAccountId: target.id,
      objectId: null,
      read: false,
      createdAt: new Date().toISOString(),
    });

    if (!target.email || !env.EMAIL || !env.FROM_EMAIL) return;
    if (env.KV) {
      const key = `report:notified:${target.id}`;
      try {
        if (await env.KV.get(key)) return;
        await env.KV.put(key, "1", { expirationTtl: 24 * 60 * 60 });
      } catch { /* best effort — a missing throttle must not block the notice */ }
    }
    await notifyAccountOwner(env, target, "reported", "Un reporte sobre tu cuenta está pendiente de revisión.");
  } catch (err) {
    console.error("[moderation] report notification failed:", err);
  }
}

/** Reject a registration — deletes the account and notifies by email. */
export async function rejectAccount(env: ModerationEnv, opts: ActionBase & { actorId: string }): Promise<ActionResult> {
  const { actorId, reason } = opts;
  const actor = await getActorById(env.DB, actorId);
  if (!actor) return { action: "rejected", applied: false, emailSent: false };
  if (actor.reserved) {
    await refuseProtectedTarget(env, actor, "reject", opts);
    return { action: "rejected", applied: false, emailSent: false };
  }

  const emailSent = await notifyAccountOwner(env, actor, "rejected", reason ?? "Su registro no cumple las normas de la instancia.");

  await env.DB.prepare("DELETE FROM actors WHERE id = ?").bind(actorId).run();
  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "account",
    targetId: actorId,
    action: "rejected",
    reason: reason ?? "Registro rechazado.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent,
    emailTo: actor.email,
    relatedId: opts.relatedId ?? null,
  });

  // Remember the rejected profile so similar spam registrations are caught
  // without a fresh AI call.
  const detailText = typeof opts.details?.content === "string" ? opts.details.content : "";
  const profileText = detailText || `${actor.username} ${actor.displayName ?? ""} ${actor.summary ?? ""}`.trim();
  if (profileText) {
    await rememberAbuse(env, {
      id: buildAbuseVectorId("registration", actorId),
      kind: "registration",
      action: "reject",
      text: profileText,
      reason: reason ?? undefined,
      // A moderator's rejection carries no model probability: it is a
      // confirmed decision, so it is never dropped as "low confidence".
      confidence: opts.confidence && opts.confidence !== "low" ? opts.confidence : "high",
      model: m.model,
    });
  }

  return { action: "rejected", applied: true, emailSent };
}

/** Warn an account — record the warning and notify the owner. */
export async function warnAccount(env: ModerationEnv, opts: ActionBase & { actorId: string }): Promise<ActionResult> {
  const { actorId, reason } = opts;
  const actor = await getActorById(env.DB, actorId);
  if (!actor) return { action: "warned", applied: false, emailSent: false };
  if (actor.reserved) {
    await refuseProtectedTarget(env, actor, "warn", opts);
    return { action: "warned", applied: false, emailSent: false };
  }

  const emailSent = await notifyAccountOwner(env, actor, "warned", reason ?? "Comportamiento que infringe las normas de la comunidad.");
  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "account",
    targetId: actorId,
    action: "warned",
    reason: reason ?? "Advertencia emitida.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent,
    emailTo: actor.email,
    relatedId: opts.relatedId ?? null,
  });
  return { action: "warned", applied: true, emailSent };
}

/** Suspend an account — blocks auth and removes the account's visible content. */
export async function suspendAccount(env: ModerationEnv, opts: ActionBase & { actorId: string }): Promise<ActionResult> {
  const { actorId, reason } = opts;
  const actor = await getActorById(env.DB, actorId);
  if (!actor) return { action: "suspended", applied: false, emailSent: false };
  if (actor.reserved) {
    await refuseProtectedTarget(env, actor, "suspend", opts);
    return { action: "suspended", applied: false, emailSent: false };
  }
  if (actor.suspended) return { action: "suspended", applied: false, emailSent: false };

  // Learn before anything is erased: the lesson embeds the offending content
  // the caller brought, a sample of the account's own posts and its profile, so
  // the next account that posts the same thing is caught by the content
  // screening without a fresh model call. The posts are nulled just below,
  // which is exactly why this has to run first.
  const m = meta(opts, SYSTEM);
  const lesson = await learnFromSuspension(env, {
    actorId,
    reason: reason ?? null,
    confidence: opts.confidence ?? null,
    model: m.model,
    content: typeof opts.details?.content === "string" ? opts.details.content : null,
  });

  // Remove visible content so toxic posts stop spreading immediately.
  await env.DB
    .prepare("UPDATE objects SET content = NULL, sensitive = 1 WHERE actor_id = ? AND content IS NOT NULL")
    .bind(actorId)
    .run();
  await env.DB
    .prepare("UPDATE actors SET suspended = 1, suspended_at = COALESCE(suspended_at, ?), updated_at = datetime('now') WHERE id = ?")
    .bind(new Date().toISOString(), actorId)
    .run();
  // Disconnect it from the fediverse: every follower marks the account
  // suspended on the next `Update{Actor}` (best effort — moderation must not
  // fail because a delivery could not be queued).
  await broadcastActorState(env, actorId).catch(() => {});

  const emailSent = await notifyAccountOwner(env, actor, "suspended", reason ?? "Su cuenta ha infringido las normas de la comunidad.");
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "account",
    targetId: actorId,
    action: "suspended",
    reason: reason ?? "Cuenta suspendida.",
    confidence: opts.confidence ?? null,
    model: m.model,
    // `learned` shows whether this suspension taught the Guardian anything.
    details: { ...(opts.details ?? {}), learned: lesson },
    emailSent,
    emailTo: actor.email,
    relatedId: opts.relatedId ?? null,
  });

  return { action: "suspended", applied: true, emailSent };
}

/**
 * Reinstate a suspended account. Deliberately allowed on the reserved actor:
 * if a bug ever suspends the Guardian, lifting it must be possible.
 */
export async function unsuspendAccount(env: ModerationEnv, opts: ActionBase & { actorId: string }): Promise<ActionResult> {
  const { actorId, reason } = opts;
  const actor = await getActorById(env.DB, actorId);
  if (!actor) return { action: "unsuspended", applied: false, emailSent: false };
  if (!actor.suspended) return { action: "unsuspended", applied: false, emailSent: false };

  await env.DB
    .prepare("UPDATE actors SET suspended = 0, suspended_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .bind(actorId)
    .run();
  // Tell the followers the account is back, or they keep treating it as gone.
  await broadcastActorState(env, actorId).catch(() => {});
  const m = meta(opts, SYSTEM);
  // A lifted suspension is a correction: stop matching the pattern.
  const forgotten = await forgetSuspension(env, actorId);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "account",
    targetId: actorId,
    action: "unsuspended",
    reason: reason ?? "Cuenta restablecida.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: { ...(opts.details ?? {}), forgotten },
    emailSent: false,
    emailTo: null,
    relatedId: opts.relatedId ?? null,
  });
  return { action: "unsuspended", applied: true, emailSent: false };
}

/** Limit (silence) an account: hide its posts from public timelines/search. */
export async function silenceAccount(env: ModerationEnv, opts: ActionBase & { actorId: string }): Promise<ActionResult> {
  const { actorId, reason } = opts;
  const actor = await getActorById(env.DB, actorId);
  if (!actor) return { action: "silenced", applied: false, emailSent: false };
  if (actor.reserved) {
    await refuseProtectedTarget(env, actor, "silence", opts);
    return { action: "silenced", applied: false, emailSent: false };
  }
  if (actor.silenced) return { action: "silenced", applied: false, emailSent: false };

  await env.DB.prepare("UPDATE actors SET silenced = 1, updated_at = datetime('now') WHERE id = ?").bind(actorId).run();
  const emailSent = await notifyAccountOwner(env, actor, "silenced", reason ?? "Su cuenta ha sido limitada.");
  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "account",
    targetId: actorId,
    action: "silenced",
    reason: reason ?? "Cuenta silenciada.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent,
    emailTo: actor.email,
    relatedId: opts.relatedId ?? null,
  });
  return { action: "silenced", applied: true, emailSent };
}

/** Reinstate a silenced account (posts appear on public timelines again). */
export async function unsilenceAccount(env: ModerationEnv, opts: ActionBase & { actorId: string }): Promise<ActionResult> {
  const { actorId, reason } = opts;
  const actor = await getActorById(env.DB, actorId);
  if (!actor) return { action: "unsilenced", applied: false, emailSent: false };
  // Like `unsuspendAccount`, a correction must stay possible on the reserved
  // actor even though nothing should ever silence it.
  if (!actor.silenced) return { action: "unsilenced", applied: false, emailSent: false };

  await env.DB.prepare("UPDATE actors SET silenced = 0, updated_at = datetime('now') WHERE id = ?").bind(actorId).run();
  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "account",
    targetId: actorId,
    action: "unsilenced",
    reason: reason ?? "Cuenta des-silenciada.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent: false,
    emailTo: null,
    relatedId: opts.relatedId ?? null,
  });
  return { action: "unsilenced", applied: true, emailSent: false };
}

/** Soft-delete a status (content stripped, flagged sensitive) and notify owner. */
export async function deleteStatus(env: ModerationEnv, opts: ActionBase & { objectId: string }): Promise<ActionResult> {
  const { objectId, reason } = opts;
  const obj = await getObjectById(env.DB, objectId);
  if (!obj) return { action: "deleted", applied: false, emailSent: false };
  if (await hadAction(env.DB, "status", objectId, "deleted")) return { action: "deleted", applied: false, emailSent: false };

  await env.DB
    .prepare("UPDATE objects SET content = NULL, sensitive = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(objectId)
    .run();

  const owner = await getActorById(env.DB, obj.actorId);
  const emailSent = owner ? await notifyAccountOwner(env, owner, "deleted", reason ?? "Contenido que infringe las normas de la comunidad.") : false;

  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "status",
    targetId: objectId,
    action: "deleted",
    reason: reason ?? "Publicación eliminada.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? { authorId: obj.actorId },
    emailSent,
    emailTo: owner?.email ?? null,
    relatedId: opts.relatedId ?? obj.actorId,
  });

  // Remember the offending text so near-duplicate spam is caught without the LLM.
  if (obj.content) {
    await rememberAbuse(env, {
      id: buildAbuseVectorId("status", objectId),
      kind: "status",
      action: "delete",
      text: stripHtml(obj.content),
      reason: reason ?? undefined,
      confidence: opts.confidence ?? undefined,
      model: m.model,
    });
  }

  return { action: "deleted", applied: true, emailSent };
}

/** Flag a status as sensitive (adult/disturbing but allowed content). */
export async function markStatusSensitive(env: ModerationEnv, opts: ActionBase & { objectId: string; spoilerText?: string }): Promise<ActionResult> {
  const { objectId, reason, spoilerText } = opts;
  const obj = await getObjectById(env.DB, objectId);
  if (!obj) return { action: "marked_sensitive", applied: false, emailSent: false };

  await env.DB
    .prepare(
      "UPDATE objects SET sensitive = 1, content_warning = COALESCE(content_warning, ?), updated_at = datetime('now') WHERE id = ?"
    )
    .bind(spoilerText ?? "Contenido sensible", objectId)
    .run();

  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "status",
    targetId: objectId,
    action: "marked_sensitive",
    reason: reason ?? "Contenido marcado como sensible.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? { authorId: obj.actorId },
    emailSent: false,
    emailTo: null,
    relatedId: opts.relatedId ?? obj.actorId,
  });
  return { action: "marked_sensitive", applied: true, emailSent: false };
}

/** Block an entire domain, suspend its cached accounts, and log it. */
export async function blockDomain(env: ModerationEnv, opts: ActionBase & { domain: string; instanceDomain: string }): Promise<ActionResult> {
  const { domain, reason, instanceDomain } = opts;
  const normalized = domain.toLowerCase().trim();
  if (!normalized || normalized === instanceDomain.toLowerCase()) {
    return { action: "blocked_domain", applied: false, emailSent: false };
  }

  const guardianId = await ensureGuardianActor(env, instanceDomain);
  if (guardianId) {
    await env.DB
      .prepare("INSERT OR IGNORE INTO domain_blocks (id, actor_id, domain) VALUES (?, ?, ?)")
      .bind(generateId(), guardianId, normalized)
      .run();
  }

  // Suspend cached remote accounts from the blocked domain so their content stops flowing.
  // Deliberately no `learnFromSuspension` here: a domain block is an
  // instance-level policy decision, not per-account confirmed abuse — teaching
  // the Guardian "everything from this domain is abuse" would poison the
  // memory and auto-action unrelated content that merely looks similar.
  await env.DB
    .prepare("UPDATE actors SET suspended = 1, suspended_at = COALESCE(suspended_at, ?), updated_at = datetime('now') WHERE domain = ? AND is_local = 0")
    .bind(new Date().toISOString(), normalized)
    .run();

  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "domain",
    targetId: normalized,
    action: "blocked_domain",
    reason: reason ?? "Dominio bloqueado por spam o contenido abusivo.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent: false,
    emailTo: null,
    relatedId: opts.relatedId ?? null,
  });
  return { action: "blocked_domain", applied: true, emailSent: false };
}

/** Mark a report as resolved (action taken) with an explanatory note. */
export async function resolveReport(env: ModerationEnv, opts: ActionBase & { reportId: string; note?: string }): Promise<ActionResult> {
  const { reportId, reason, note } = opts;
  const existing = await env.DB.prepare("SELECT id FROM reports WHERE id = ?").bind(reportId).first();
  if (!existing) return { action: "resolved", applied: false, emailSent: false };

  const noteText = (note ?? reason ?? "Resuelto automáticamente por el Guardian.").trim();
  await env.DB
    .prepare("UPDATE reports SET action_taken = 1, comment = CASE WHEN comment = '' THEN ? ELSE comment || '\n' || ? END WHERE id = ?")
    .bind(noteText, noteText, reportId)
    .run();

  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "report",
    targetId: reportId,
    action: "resolved",
    reason: reason ?? "Reporte resuelto.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent: false,
    emailTo: null,
    relatedId: opts.relatedId ?? null,
  });
  return { action: "resolved", applied: true, emailSent: false };
}

/** Dismiss a report without action (removes it, as the admin API does). */
export async function dismissReport(env: ModerationEnv, opts: ActionBase & { reportId: string }): Promise<ActionResult> {
  const { reportId, reason } = opts;
  const existing = await env.DB.prepare("SELECT id FROM reports WHERE id = ?").bind(reportId).first();
  if (!existing) return { action: "dismissed", applied: false, emailSent: false };

  await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(reportId).run();
  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: "report",
    targetId: reportId,
    action: "dismissed",
    reason: reason ?? "Reporte descartado.",
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent: false,
    emailTo: null,
    relatedId: opts.relatedId ?? null,
  });
  return { action: "dismissed", applied: true, emailSent: false };
}

/** Record that the Guardian reviewed something and took no action (dismiss/monitor). */
export async function recordNoAction(
  env: ModerationEnv,
  opts: ActionBase & { targetType: "account" | "status" | "report" | "domain" | "instance"; targetId: string | null; action?: string }
): Promise<void> {
  const m = meta(opts, SYSTEM);
  await recordModeration(env, {
    id: generateId(),
    source: m.source,
    targetType: opts.targetType,
    targetId: opts.targetId,
    action: opts.action ?? "no_action",
    reason: opts.reason ?? null,
    confidence: opts.confidence ?? null,
    model: m.model,
    details: opts.details ?? {},
    emailSent: false,
    emailTo: null,
    relatedId: opts.relatedId ?? null,
  });
}

export { GUARDIAN_MODEL };
