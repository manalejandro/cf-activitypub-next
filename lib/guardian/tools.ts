/**
 * The Guardian's tools — what the Cloudflare Agent can actually do.
 *
 * Reads are free: the model can inspect the instance, one account, the reports
 * and the audit trail on its own. Every **mutation** is a `needsApproval` tool,
 * so the model can propose "suspend @spammer because…" but a human
 * administrator approves it in the chat before anything happens — the same
 * human-in-the-loop contract Mastodon's moderation queue has.
 *
 * Approved actions go through the moderation engine (`lib/moderation/actions`),
 * so they land in `moderation_log` with `model: "guardian-agent"` exactly like
 * the scheduled cycle's decisions, and the audit trail stays the single source
 * of truth.
 *
 * The tools are built from the bindings so they can be unit-tested without a
 * Durable Object.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  deleteStatus,
  silenceAccount,
  suspendAccount,
  unsuspendAccount,
  warnAccount,
  type ModerationEnv,
} from "@/lib/moderation/actions";
import { evaluateReportWithAI } from "@/lib/moderation/reportAI";
import { getGuardianSnapshot } from "./snapshot";
import { getActorByUsername, getObjectById } from "@/lib/db";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import type { LocalActor, LocalObject } from "@/lib/types";

export interface GuardianToolEnv extends ModerationEnv {
  DB: D1Database;
  INSTANCE_URL?: string;
}

/** Model id recorded on the actions the agent performs. */
export const GUARDIAN_AGENT_MODEL = "guardian-agent";

const MAX_LIMIT = 20;

function hostOf(env: GuardianToolEnv): string {
  try {
    return new URL(env.INSTANCE_URL ?? "http://localhost:3000").hostname;
  } catch {
    return "localhost";
  }
}

/**
 * Resolve an account from a handle (`@user`, `@user@domain`), a bare username
 * or an actor id. Only the local database is consulted — the agent never makes
 * the Worker fetch its own hostname or a remote profile mid-chat.
 */
async function resolveAccount(env: GuardianToolEnv, value: string): Promise<LocalActor | null> {
  const raw = value.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return getActorByUsername(env.DB, raw.split("/").pop() ?? "", new URL(raw).hostname);
  const handle = raw.replace(/^@/, "");
  const [username, domain] = handle.includes("@") ? handle.split("@", 2) : [handle, null];
  if (!username) return null;
  return getActorByUsername(env.DB, username, domain ?? hostOf(env));
}

function accountLine(a: { id: string; username: string; domain: string; isLocal: boolean; suspended?: boolean; silenced?: boolean }): string {
  const acct = a.isLocal ? a.username : `${a.username}@${a.domain}`;
  const flags = [a.suspended ? "suspended" : null, a.silenced ? "limited" : null].filter(Boolean).join(", ");
  return `@${acct}${flags ? ` (${flags})` : ""}`;
}

function excerpt(content: string | null, length = 160): string {
  const text = (content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/**
 * Resolve a status from either the stored object IRI (what the tools return) or
 * a Mastodon API id (the UUID or base64url form an admin copies from the web UI).
 */
async function resolveStatus(env: GuardianToolEnv, value: string): Promise<LocalObject | null> {
  const raw = value.trim();
  if (!raw) return null;
  const direct = await getObjectById(env.DB, raw);
  if (direct) return direct;
  const iri = decodeStatusId(raw, hostOf(env));
  return iri === raw ? null : getObjectById(env.DB, iri);
}

export function buildGuardianTools(env: GuardianToolEnv) {
  return {
    instance_overview: tool({
      description:
        "Current moderation picture of the instance: account and status counts, open reports, registrations waiting for approval, and the decisions taken in the last 24 hours.",
      inputSchema: z.object({}),
      execute: async () => getGuardianSnapshot(env),
    }),

    list_reports: tool({
      description:
        "List user reports, newest first. `open` (the default) are the tickets nobody has acted on yet; `all` includes the resolved ones. Each entry names the target, the reporter, the category, the comment and how many evidence statuses it carries.",
      inputSchema: z.object({
        status: z.enum(["open", "all"]).default("open"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(10),
      }),
      execute: async ({ status, limit }) => {
        const rows = await env.DB.prepare(
          `SELECT r.id, r.category, r.comment, r.forwarded, r.action_taken, r.created_at,
                  r.status_ids, r.target_id, r.actor_id,
                  t.username AS target_username, t.domain AS target_domain, t.is_local AS target_local,
                  t.suspended AS target_suspended,
                  a.username AS reporter_username, a.domain AS reporter_domain
             FROM reports r
             LEFT JOIN actors t ON t.id = r.target_id
             LEFT JOIN actors a ON a.id = r.actor_id
            ${status === "open" ? "WHERE r.action_taken = 0" : ""}
            ORDER BY r.created_at DESC
            LIMIT ?`
        )
          .bind(limit)
          .all<Record<string, unknown>>();
        return (rows.results ?? []).map((r) => ({
          id: r.id as string,
          created_at: r.created_at as string,
          category: r.category as string,
          comment: excerpt(r.comment as string | null, 300),
          target: r.target_username
            ? `@${r.target_username}${r.target_local ? "" : `@${r.target_domain}`}${r.target_suspended ? " (suspended)" : ""}`
            : (r.target_id as string),
          reporter: r.reporter_username
            ? `@${r.reporter_username}${r.reporter_domain === hostOf(env) ? "" : `@${r.reporter_domain}`}`
            : (r.actor_id as string),
          forwarded_to_origin: Boolean(r.forwarded),
          action_taken: Boolean(r.action_taken),
          evidence_statuses: r.status_ids ? (JSON.parse(r.status_ids as string) as string[]).length : 0,
        }));
      },
    }),

    get_account: tool({
      description:
        "Everything known about one account: profile, activity, suspension state, reports received and its latest moderation decisions. Accepts @user, @user@domain or an actor id.",
      inputSchema: z.object({ account: z.string() }),
      execute: async ({ account }) => {
        const actor = await resolveAccount(env, account);
        if (!actor) return { error: `No account matches ${account} in the local database.` };
        const [reports, decisions, statuses] = await Promise.all([
          env.DB.prepare(
            `SELECT COUNT(*) AS n, SUM(CASE WHEN action_taken = 0 THEN 1 ELSE 0 END) AS open
               FROM reports WHERE target_id = ?`
          )
            .bind(actor.id)
            .first<{ n: number; open: number }>(),
          env.DB.prepare(
            `SELECT action, reason, confidence, model, created_at FROM moderation_log
              WHERE target_id = ? ORDER BY created_at DESC LIMIT 5`
          )
            .bind(actor.id)
            .all<Record<string, unknown>>(),
          env.DB.prepare(
            `SELECT id, content, published, visibility, engagement FROM objects
              WHERE actor_id = ? ORDER BY published DESC LIMIT 5`
          )
            .bind(actor.id)
            .all<Record<string, unknown>>(),
        ]);
        return {
          account: accountLine(actor),
          id: actor.id,
          display_name: actor.displayName,
          bio: excerpt(actor.summary, 300),
          local: actor.isLocal,
          bot: actor.isBot,
          suspended: Boolean(actor.suspended),
          limited: Boolean(actor.silenced),
          memorial: Boolean(actor.memorial),
          created_at: actor.createdAt,
          followers: actor.followersCount,
          following: actor.followingCount,
          statuses: actor.statusesCount,
          reports: { total: Number(reports?.n ?? 0), open: Number(reports?.open ?? 0) },
          recent_decisions: (decisions.results ?? []).map((d) => ({
            action: d.action as string,
            reason: d.reason as string | null,
            confidence: d.confidence as string | null,
            by: d.model as string,
            at: d.created_at as string,
          })),
          recent_statuses: (statuses.results ?? []).map((s) => ({
            id: s.id as string,
            published: s.published as string,
            visibility: s.visibility as string,
            engagement: Number(s.engagement ?? 0),
            text: excerpt(s.content as string | null),
          })),
        };
      },
    }),

    search_statuses: tool({
      description:
        "Search recent statuses by text (substring, case-insensitive) or by hashtag. Returns the newest matches with their author and engagement.",
      inputSchema: z.object({
        query: z.string().min(2),
        days: z.number().int().min(1).max(30).default(7),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(10),
      }),
      execute: async ({ query, days, limit }) => {
        // D1 rejects LIKE patterns over 50 characters, and a bare `%` would
        // scan the whole table: keep it a bounded substring.
        const needle = `%${query.trim().slice(0, 40).replace(/[%_\\]/g, "\\$&")}%`;
        const rows = await env.DB.prepare(
          `SELECT o.id, o.content, o.published, o.visibility, o.engagement, o.type,
                  a.username, a.domain, a.is_local, a.suspended
             FROM objects o JOIN actors a ON a.id = o.actor_id
            WHERE o.content LIKE ? ESCAPE '\\'
              AND o.published >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
            ORDER BY o.published DESC
            LIMIT ?`
        )
          .bind(needle, `-${days} days`, limit)
          .all<Record<string, unknown>>();
        return (rows.results ?? []).map((r) => ({
          id: r.id as string,
          author: `@${r.username}${r.is_local ? "" : `@${r.domain}`}${r.suspended ? " (suspended)" : ""}`,
          published: r.published as string,
          visibility: r.visibility as string,
          engagement: Number(r.engagement ?? 0),
          text: excerpt(r.content as string | null, 240),
        }));
      },
    }),

    recent_decisions: tool({
      description: "The latest entries of the moderation audit trail (who acted, on whom, why and with what confidence).",
      inputSchema: z.object({ limit: z.number().int().min(1).max(MAX_LIMIT).default(10) }),
      execute: async ({ limit }) => {
        const rows = await env.DB.prepare(
          `SELECT l.action, l.target_type, l.target_id, l.reason, l.confidence, l.model, l.created_at,
                  a.username, a.domain, a.is_local
             FROM moderation_log l LEFT JOIN actors a ON a.id = l.target_id
            ORDER BY l.created_at DESC LIMIT ?`
        )
          .bind(limit)
          .all<Record<string, unknown>>();
        return (rows.results ?? []).map((r) => ({
          action: r.action as string,
          target: r.username ? `@${r.username}${r.is_local ? "" : `@${r.domain}`}` : (r.target_id as string | null),
          target_type: r.target_type as string,
          reason: excerpt(r.reason as string | null, 200),
          confidence: r.confidence as string | null,
          by: r.model as string,
          at: r.created_at as string,
        }));
      },
    }),

    review_report: tool({
      description:
        "Run the Guardian's own reasoning pipeline on an open report: it reads the evidence, decides (dismiss / warn / delete / suspend) and applies the verdict, recording everything in the audit trail. Use it when the human wants the automated judgement instead of deciding by hand.",
      inputSchema: z.object({ report_id: z.string() }),
      needsApproval: true,
      execute: async ({ report_id }) => {
        const report = await env.DB.prepare(
          `SELECT r.id, r.category, r.comment, r.status_ids, r.target_id, r.actor_id,
                  t.username AS target_username, a.username AS reporter_username, a.email AS reporter_email
             FROM reports r
             LEFT JOIN actors t ON t.id = r.target_id
             LEFT JOIN actors a ON a.id = r.actor_id
            WHERE r.id = ?`
        )
          .bind(report_id)
          .first<Record<string, unknown>>();
        if (!report) return { error: `Report ${report_id} not found.` };
        const domain = hostOf(env);
        await evaluateReportWithAI(env, {
          reportId: report.id as string,
          category: (report.category as string) ?? "other",
          comment: (report.comment as string) ?? "",
          statusIds: report.status_ids ? (JSON.parse(report.status_ids as string) as string[]) : [],
          domain,
          target: { id: report.target_id as string, username: (report.target_username as string) ?? "" },
          reporter: {
            id: report.actor_id as string,
            username: (report.reporter_username as string) ?? "",
            email: (report.reporter_email as string | null) ?? null,
          },
        });
        const after = await env.DB.prepare(
          "SELECT action, reason, confidence FROM moderation_log WHERE related_id = ? ORDER BY created_at DESC LIMIT 1"
        )
          .bind(report_id)
          .first<{ action: string; reason: string | null; confidence: string | null }>();
        return { reviewed: true, verdict: after?.action ?? "no_action", reason: after?.reason ?? null, confidence: after?.confidence ?? null };
      },
    }),

    suspend_account: tool({
      description:
        "Suspend an account: it can no longer sign in, its posts disappear from the timelines and the change is federated to its followers. Reversible with unsuspend_account.",
      inputSchema: z.object({ account: z.string(), reason: z.string().min(3) }),
      needsApproval: true,
      execute: async ({ account, reason }) => {
        const actor = await resolveAccount(env, account);
        if (!actor) return { error: `No account matches ${account}.` };
        const result = await suspendAccount(env, {
          actorId: actor.id,
          reason,
          confidence: "high",
          source: "user",
          model: GUARDIAN_AGENT_MODEL,
          details: { stage: "agent" },
        });
        return { applied: result.applied, account: accountLine(actor) };
      },
    }),

    unsuspend_account: tool({
      description: "Lift a suspension and bring the account (and its posts) back.",
      inputSchema: z.object({ account: z.string(), reason: z.string().min(3) }),
      needsApproval: true,
      execute: async ({ account, reason }) => {
        const actor = await resolveAccount(env, account);
        if (!actor) return { error: `No account matches ${account}.` };
        const result = await unsuspendAccount(env, {
          actorId: actor.id,
          reason,
          confidence: "high",
          source: "user",
          model: GUARDIAN_AGENT_MODEL,
          details: { stage: "agent" },
        });
        return { applied: result.applied, account: accountLine(actor) };
      },
    }),

    silence_account: tool({
      description:
        "Limit (silence) an account: its posts leave the public timelines and trends but stay visible to its followers. Reversible with the panel.",
      inputSchema: z.object({ account: z.string(), reason: z.string().min(3) }),
      needsApproval: true,
      execute: async ({ account, reason }) => {
        const actor = await resolveAccount(env, account);
        if (!actor) return { error: `No account matches ${account}.` };
        const result = await silenceAccount(env, {
          actorId: actor.id,
          reason,
          confidence: "high",
          source: "user",
          model: GUARDIAN_AGENT_MODEL,
          details: { stage: "agent" },
        });
        return { applied: result.applied, account: accountLine(actor) };
      },
    }),

    warn_account: tool({
      description: "Warn an account: the owner gets an email and the warning is counted before heavier actions.",
      inputSchema: z.object({ account: z.string(), reason: z.string().min(3) }),
      needsApproval: true,
      execute: async ({ account, reason }) => {
        const actor = await resolveAccount(env, account);
        if (!actor) return { error: `No account matches ${account}.` };
        const result = await warnAccount(env, {
          actorId: actor.id,
          reason,
          confidence: "high",
          source: "user",
          model: GUARDIAN_AGENT_MODEL,
          details: { stage: "agent" },
        });
        return { applied: result.applied, account: accountLine(actor) };
      },
    }),

    delete_status: tool({
      description:
        "Delete one status permanently (it is also removed from the remote instances that stored it). Accepts the status id the tools return or a Mastodon API status id.",
      inputSchema: z.object({ status_id: z.string(), reason: z.string().min(3) }),
      needsApproval: true,
      execute: async ({ status_id, reason }) => {
        const object = await resolveStatus(env, status_id);
        if (!object) return { error: `Status ${status_id} is not in the database.` };
        const result = await deleteStatus(env, {
          objectId: object.id,
          reason,
          confidence: "high",
          source: "user",
          model: GUARDIAN_AGENT_MODEL,
          details: { stage: "agent" },
        });
        return { applied: result.applied, status: object.id, author: object.actorId };
      },
    }),
  };
}

export type GuardianTools = ReturnType<typeof buildGuardianTools>;
