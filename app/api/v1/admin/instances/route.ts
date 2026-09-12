import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import {
  getInstance,
  listInstances,
  recordInstanceSuccess,
  setInstanceSuspended,
} from "@/lib/db";
import { normalizeDomain, purgeInstanceDomain, refreshInstance, setInstancePausedMarker } from "@/lib/activitypub/instances";
import { resolveLimits } from "@/lib/constants";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";

// GET /api/v1/admin/instances — federation registry (search/filter/paginate).
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const params = request.nextUrl.searchParams;
  const limit = Math.min(
    parseInt(params.get("limit") ?? String(limits.pageSize)),
    limits.maxCollectionPage
  );
  const page = Math.max(parseInt(params.get("page") ?? "1"), 1);

  const { instances, total } = await listInstances(env.DB, {
    limit,
    offset: (page - 1) * limit,
    query: params.get("q")?.trim() ?? "",
    status: params.get("status") ?? "all",
    dormantDays: limits.instanceDormantDays,
  });
  return json({ instances, total, page, limit });
}

// POST /api/v1/admin/instances — add/refresh an instance or change its state.
// body: { domain, action?: "add" | "refresh" | "reset" | "suspend" | "unsuspend" }
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { domain?: unknown; action?: unknown };
  try {
    body = (await request.json()) as { domain?: unknown; action?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }
  const host = normalizeDomain(typeof body.domain === "string" ? body.domain : null);
  if (!host) return badRequest("domain is required");

  const action = typeof body.action === "string" ? body.action : "add";
  switch (action) {
    case "suspend":
    case "unsuspend": {
      const suspended = action === "suspend";
      await setInstanceSuspended(env.DB, host, suspended);
      await setInstancePausedMarker(env.KV, host, suspended);
      await recordModeration(env, {
        id: generateId(),
        source: "user",
        targetType: "instance",
        targetId: host,
        action: suspended ? "suspend" : "unsuspend",
        reason: suspended
          ? "Instance suspended by an administrator."
          : "Instance suspension lifted by an administrator.",
        confidence: null,
        model: "admin",
        details: {},
        emailSent: false,
        emailTo: null,
        relatedId: null,
      });
      return json({ ok: true, instance: await getInstance(env.DB, host) });
    }
    case "reset": {
      // Clear the DeliveryFailureTracker state so deliveries resume at once.
      await recordInstanceSuccess(env.DB, host);
      return json({ ok: true, instance: await getInstance(env.DB, host) });
    }
    case "refresh":
    case "add":
    default: {
      const result = await refreshInstance(env.DB, env.KV, host, { force: true });
      return json({
        ok: result.ok,
        reason: result.reason ?? null,
        instance: await getInstance(env.DB, host),
      });
    }
  }
}

// DELETE /api/v1/admin/instances?domain= — purge every cached actor/post.
export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const host = normalizeDomain(request.nextUrl.searchParams.get("domain"));
  if (!host) return badRequest("domain is required");

  const purged = await purgeInstanceDomain(env.DB, host);
  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "instance",
    targetId: host,
    action: "delete",
    reason: "Instance data purged by an administrator.",
    confidence: null,
    model: "admin",
    details: { actors: purged },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });
  return json({ ok: true, purged });
}
