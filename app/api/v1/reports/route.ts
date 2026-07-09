import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { createReport, getActorById, getReportById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { generateId } from "@/lib/activitypub/utils";

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