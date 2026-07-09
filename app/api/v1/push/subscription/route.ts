import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import {
  getPushSubscription,
  upsertPushSubscription,
  updatePushSubscriptionAlerts,
  deletePushSubscription,
} from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";

// GET /api/v1/push/subscription
export async function GET(_request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(_request, env.DB);
  if (!actor) return unauthorized();

  const sub = await getPushSubscription(env.DB, actor.id);
  if (!sub) return notFound("Record not found");

  let alerts: Record<string, boolean> = {};
  try { alerts = JSON.parse(sub.alerts); } catch { /* empty */ }

  return json({
    id: sub.id,
    endpoint: sub.endpoint,
    standard: sub.standard,
    alerts,
    server_key: sub.serverKey,
  });
}

// POST /api/v1/push/subscription
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";

  let endpoint = "";
  let p256dh = "";
  let auth = "";
  let standard = false;
  const alerts: Record<string, boolean> = {};
  let policy = "all";

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    const sub = body.subscription as Record<string, unknown> | undefined;
    if (sub) {
      endpoint = (sub.endpoint as string) ?? "";
      const keys = sub.keys as Record<string, string> | undefined;
      p256dh = keys?.p256dh ?? "";
      auth = keys?.auth ?? "";
      standard = (sub.standard as boolean) ?? false;
    }
    const data = body.data as Record<string, unknown> | undefined;
    if (data) {
      const dataAlerts = data.alerts as Record<string, boolean> | undefined;
      if (dataAlerts) Object.assign(alerts, dataAlerts);
      if (data.policy) policy = data.policy as string;
    }
  } else {
    const form = await request.formData();
    endpoint = (form.get("subscription[endpoint]") as string) ?? "";
    p256dh = (form.get("subscription[keys][p256dh]") as string) ?? "";
    auth = (form.get("subscription[keys][auth]") as string) ?? "";
    standard = (form.get("subscription[standard]") as string) === "true";

    for (const alertName of [
      "mention", "status", "reblog", "follow", "follow_request",
      "favourite", "poll", "update", "quote",
    ]) {
      const val = form.get(`data[alerts][${alertName}]`);
      if (val !== null) alerts[alertName] = val === "true";
    }

    const policyVal = form.get("data[policy]") as string | null;
    if (policyVal) policy = policyVal;
  }

  if (!endpoint || !p256dh || !auth) {
    return json({ error: "subscription[endpoint], subscription[keys][p256dh], and subscription[keys][auth] are required" }, 422);
  }

  await upsertPushSubscription(env.DB, {
    id: generateId(),
    actorId: actor.id,
    endpoint,
    p256dhKey: p256dh,
    authKey: auth,
    standard,
    policy,
    alerts: JSON.stringify(alerts),
    serverKey: "",
  });

  const sub = await getPushSubscription(env.DB, actor.id);

  return json({
    id: sub!.id,
    endpoint: sub!.endpoint,
    standard: sub!.standard,
    alerts: alerts,
    server_key: sub!.serverKey,
  });
}

// PUT /api/v1/push/subscription
export async function PUT(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const existing = await getPushSubscription(env.DB, actor.id);
  if (!existing) return notFound("Record not found");

  const contentType = request.headers.get("Content-Type") ?? "";

  const alerts: Record<string, boolean> = {};
  let policy: string | undefined;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | undefined;
    if (data) {
      const dataAlerts = data.alerts as Record<string, boolean> | undefined;
      if (dataAlerts) Object.assign(alerts, dataAlerts);
      if (data.policy !== undefined) policy = data.policy as string;
    }
  } else {
    const form = await request.formData();
    for (const alertName of [
      "mention", "status", "reblog", "follow", "follow_request",
      "favourite", "poll", "update", "quote",
    ]) {
      const val = form.get(`data[alerts][${alertName}]`);
      if (val !== null) alerts[alertName] = val === "true";
    }
    const policyVal = form.get("policy") as string | null;
    if (policyVal) policy = policyVal;
  }

  const mergedAlerts = { ...JSON.parse(existing.alerts), ...alerts };
  await updatePushSubscriptionAlerts(env.DB, actor.id, JSON.stringify(mergedAlerts), policy);

  const updated = await getPushSubscription(env.DB, actor.id);
  let updatedAlerts: Record<string, boolean> = {};
  try { updatedAlerts = JSON.parse(updated!.alerts); } catch { /* empty */ }

  return json({
    id: updated!.id,
    endpoint: updated!.endpoint,
    standard: updated!.standard,
    alerts: updatedAlerts,
    server_key: updated!.serverKey,
  });
}

// DELETE /api/v1/push/subscription
export async function DELETE(_request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(_request, env.DB);
  if (!actor) return unauthorized();

  await deletePushSubscription(env.DB, actor.id);

  return json({});
}
