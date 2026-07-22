import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { createReport, getActorById, getReportById, getReportsByActor, getObjectById } from "@/lib/db";
import { serializeAccount, serializeStatus } from "@/lib/mastodon/serializers";
import { generateId } from "@/lib/activitypub/utils";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { evaluateReport } from "@/lib/moderation/ai";
import { sendReportOutcomeEmail } from "@/lib/email";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const reports = await getReportsByActor(env.DB, actor.id);

  const result = await Promise.all(
    reports.map(async (r) => {
      const target = await getActorById(env.DB, r.target_id);
      let statusIds: string[] = [];
      let statuses: Record<string, unknown>[] = [];
      if (r.status_ids) {
        statusIds = JSON.parse(r.status_ids) as string[];
        statuses = (await Promise.all(
          statusIds.map(async (sid) => {
            const decoded = decodeStatusId(sid, domain);
            const obj = await getObjectById(env.DB, decoded);
            if (!obj) return null;
            const author = await getActorById(env.DB, obj.actorId);
            if (!author) return null;
            return {
              id: sid,
              content: obj.content,
              account: serializeAccount(author, domain),
              created_at: obj.published,
            };
          })
        )).filter(Boolean) as Record<string, unknown>[];
      }
      return {
        id: r.id,
        action_taken: r.action_taken,
        action_taken_at: null,
        category: r.category,
        comment: r.comment,
        forwarded: r.forwarded,
        created_at: r.created_at,
        status_ids: statusIds,
        statuses,
        rule_ids: r.rule_ids ? JSON.parse(r.rule_ids) : [],
        target_account: target ? serializeAccount(target, domain) : null,
      };
    })
  );

  return json(result);
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";
  let accountId = "";
  let statusIds: string[] = [];
  let comment = "";
  let category = "other";
  let ruleIds: string[] = [];
  let forward = false;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    accountId = (body.account_id as string) ?? "";
    statusIds = (body.status_ids as string[]) ?? [];
    comment = (body.comment as string) ?? "";
    category = (body.category as string) ?? "other";
    ruleIds = (body.rule_ids as string[]) ?? [];
    forward = Boolean(body.forward);
  } else {
    const form = await request.formData();
    accountId = (form.get("account_id") as string) ?? "";
    statusIds = form.getAll("status_ids[]").map((v) => v.toString());
    comment = (form.get("comment") as string) ?? "";
    category = (form.get("category") as string) ?? "other";
    ruleIds = form.getAll("rule_ids[]").map((v) => v.toString());
    forward = (form.get("forward") as string) === "true";
  }

  if (!accountId) return json({ error: "account_id is required" }, 422);

  const target = await getActorById(env.DB, accountId);
  if (!target) return notFound();

  const id = generateId();
  await createReport(
    env.DB,
    id,
    actor.id,
    target.id,
    statusIds.length > 0 ? JSON.stringify(statusIds) : null,
    comment,
    category,
    ruleIds.length > 0 ? JSON.stringify(ruleIds) : null,
    forward
  );

  // AI moderation: evaluate the report and take action automatically
  if (env.AI) {
    try {
      const statusContents: string[] = [];
      let invalidStatuses = false;
      let mismatchedOwnership = false;

      for (const sid of statusIds) {
        const decoded = decodeStatusId(sid, domain);
        const obj = await getObjectById(env.DB, decoded);
        if (!obj) {
          invalidStatuses = true;
          continue;
        }
        if (obj.actorId !== target.id) {
          mismatchedOwnership = true;
        }
        if (obj?.content) {
          const stripped = obj.content.replace(/<[^>]+>/g, "").trim();
          if (stripped) statusContents.push(stripped);
        }
      }

      const verdict = await evaluateReport(env as { AI: Ai; DB: D1Database }, {
        category,
        comment,
        statusContent: statusContents.join("\n---\n").slice(0, 2000),
        targetUsername: target.username,
        reporterUsername: actor.username,
        invalidStatuses,
        mismatchedOwnership,
      });

      if (verdict && verdict.confidence !== "low") {
        let actionNote = `[AI] Decisión: ${verdict.action}. Razón: ${verdict.reason} (confianza: ${verdict.confidence})`;

        if (verdict.action === "suspend") {
          await env.DB.prepare("UPDATE actors SET suspended = 1 WHERE id = ?").bind(target.id).run();
          actionNote += " — Cuenta suspendida.";
        }

        if (verdict.action === "delete") {
          for (const sid of statusIds) {
            const decoded = decodeStatusId(sid, domain);
            await env.DB.prepare("UPDATE objects SET content = NULL, sensitive = 1 WHERE id = ?").bind(decoded).run();
          }
          actionNote += " — Publicación(es) eliminada(s).";
        }

        await env.DB.prepare(
          "UPDATE reports SET action_taken = 1, comment = comment || '\n' || ? WHERE id = ?"
        ).bind(actionNote, id).run();

        if (actor.email && env.EMAIL) {
          try {
            await sendReportOutcomeEmail(env.EMAIL, {
              to: actor.email,
              from: env.FROM_EMAIL,
              reporterUsername: actor.username,
              targetUsername: target.username,
              action: verdict.action,
              reason: verdict.reason,
              instanceTitle: env.INSTANCE_TITLE,
            });
          } catch {
            // email error — don't fail the report
          }
        }
      }
    } catch {
      // AI error — leave report open for manual review
    }
  }

  return json({
    id,
    action_taken: false,
    action_taken_at: null,
    category,
    comment,
    forwarded: forward,
    created_at: new Date().toISOString(),
    status_ids: statusIds.length > 0 ? statusIds : null,
    rule_ids: ruleIds.length > 0 ? ruleIds : null,
    target_account: serializeAccount(target, domain),
  });
}