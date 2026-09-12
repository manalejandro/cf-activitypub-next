/**
 * Moderation audit trail — one row per automated decision.
 *
 * Every action the Guardian takes (suspensions, warnings, deletions, approvals,
 * domain blocks, report resolutions, ...) is recorded here so the instance can
 * be audited later without a human admin having been involved.
 */

export type ModerationSource = "ai" | "heuristic" | "system" | "user";

export interface ModerationLogEntry {
  id: string;
  createdAt: string;
  source: ModerationSource;
  targetType: "account" | "status" | "report" | "domain" | "instance";
  targetId: string | null;
  action: string;
  reason: string | null;
  confidence: "low" | "medium" | "high" | null;
  model: string;
  details: Record<string, unknown>;
  emailSent: boolean;
  emailTo: string | null;
  relatedId: string | null;
}

interface LogEnv {
  DB: D1Database;
}

/** Insert one moderation event into the audit trail. */
export async function recordModeration(env: LogEnv, entry: Omit<ModerationLogEntry, "createdAt">): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO moderation_log
        (id, source, target_type, target_id, action, reason, confidence, model, details, email_sent, email_to, related_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        entry.id,
        entry.source,
        entry.targetType,
        entry.targetId,
        entry.action,
        entry.reason,
        entry.confidence,
        entry.model,
        JSON.stringify(entry.details ?? {}),
        entry.emailSent ? 1 : 0,
        entry.emailTo,
        entry.relatedId
      )
      .run();
  } catch {
    // Never let logging break the main flow.
  }
}

export interface LogQuery {
  limit?: number;
  offset?: number;
  targetType?: string;
  action?: string;
  targetId?: string;
}

const LOG_SELECT = "id, created_at, source, target_type, target_id, action, reason, confidence, model, details, email_sent, email_to, related_id";

/** Total rows matching the same filters as getModerationLog (admin pagination). */
export async function countModerationLog(db: D1Database, query: LogQuery = {}): Promise<number> {
  let sql = "SELECT COUNT(*) AS n FROM moderation_log WHERE 1=1";
  const binds: unknown[] = [];
  if (query.targetType) {
    sql += " AND target_type = ?";
    binds.push(query.targetType);
  }
  if (query.action) {
    sql += " AND action = ?";
    binds.push(query.action);
  }
  if (query.targetId) {
    sql += " AND target_id = ?";
    binds.push(query.targetId);
  }
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function getModerationLog(db: D1Database, query: LogQuery = {}): Promise<ModerationLogEntry[]> {
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;

  let sql = `SELECT ${LOG_SELECT} FROM moderation_log WHERE 1=1`;
  const binds: unknown[] = [];
  if (query.targetType) {
    sql += " AND target_type = ?";
    binds.push(query.targetType);
  }
  if (query.action) {
    sql += " AND action = ?";
    binds.push(query.action);
  }
  if (query.targetId) {
    sql += " AND target_id = ?";
    binds.push(query.targetId);
  }
  sql += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
  binds.push(limit, offset);

  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();

  return rows.results.map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    source: String(r.source) as ModerationSource,
    targetType: String(r.target_type) as ModerationLogEntry["targetType"],
    targetId: r.target_id ? String(r.target_id) : null,
    action: String(r.action),
    reason: r.reason ? String(r.reason) : null,
    confidence: r.confidence ? (String(r.confidence) as ModerationLogEntry["confidence"]) : null,
    model: String(r.model),
    details: parseDetails(r.details),
    emailSent: Boolean(r.email_sent),
    emailTo: r.email_to ? String(r.email_to) : null,
    relatedId: r.related_id ? String(r.related_id) : null,
  }));
}

function parseDetails(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Number of warning actions recorded against an account (used for escalation). */
export async function countWarnings(db: D1Database, actorId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM moderation_log WHERE target_type = 'account' AND target_id = ? AND action = 'warned'")
    .bind(actorId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** Whether a given object id already had an action applied (idempotency). */
export async function hadAction(db: D1Database, targetType: string, targetId: string, action: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM moderation_log WHERE target_type = ? AND target_id = ? AND action = ? LIMIT 1")
    .bind(targetType, targetId, action)
    .first();
  return Boolean(row);
}
