import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { createReport, getActorById, getReportsByActor, getObjectById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { buildFlag, generateId } from "@/lib/activitypub/utils";
import { deliverToInbox } from "@/lib/activitypub/federation";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { evaluateReportWithAI } from "@/lib/moderation/reportAI";
import { recordNoAction } from "@/lib/moderation/actions";

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

  // Federated forward: when the reported account lives on another instance and
  // the reporter opted in, deliver a Mastodon-compatible Flag activity to that
  // server so its admins get the full evidence (the reported statuses' IRIs) to
  // make a moderation decision. Only already-public object IRIs are included —
  // nothing about this instance is disclosed beyond the statuses themselves.
  if (forward && !target.isLocal) {
    try {
      const baseUrl = `https://${domain}`;
      const statusUris: string[] = [];
      for (const sid of statusIds) {
        const decoded = decodeStatusId(sid, domain);
        if (decoded.startsWith("http")) statusUris.push(decoded);
      }

      if (actor.privateKeyPem) {
        const flag = buildFlag(baseUrl, actor.id, target.id, generateId(), {
          content: comment,
          statusUris,
        });
        let inboxUrl = target.inbox ?? `${target.id}/inbox`;
        // Ensure the remote actor's inbox is available before delivering.
        if (!target.inbox) {
          const refreshed = await fetchAndCacheRemoteActor(env.DB, target.id, env.KV);
          if (refreshed?.inbox) inboxUrl = refreshed.inbox;
        }
        try {
          await deliverToInbox(inboxUrl, flag, `${actor.id}#main-key`, actor.privateKeyPem);
          await env.DB.prepare("UPDATE reports SET forwarded = 1 WHERE id = ?").bind(id).run();
        } catch (err) {
          console.error("[reports] Flag forward failed:", err);
        }
      }
    } catch (err) {
      console.error("[reports] Flag build failed:", err);
    }
  }

  // AI moderation: evaluate the report with the Guardian and take action
  // automatically. Every decision is recorded in moderation_log. The same
  // pipeline runs for inbound federated Flag activities (see handleFlag).
  if (env.AI) {
    try {
      await evaluateReportWithAI(env, {
        reportId: id,
        category,
        comment,
        statusIds,
        domain,
        target: { id: target.id, username: target.username },
        reporter: { id: actor.id, username: actor.username, email: actor.email },
      });
    } catch (e) {
      console.error("[reports] AI moderation error:", e);
      // AI error — leave report open for the scheduled moderation cycle.
      await recordNoAction(env, {
        targetType: "report",
        targetId: id,
        action: "no_action",
        reason: "Error interno al evaluar el reporte.",
        confidence: undefined,
        source: "system",
        model: "system",
        details: { stage: "report", reporterId: actor.id, targetId: target.id, category, reviewedStatuses: [] },
        relatedId: actor.id,
      });
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