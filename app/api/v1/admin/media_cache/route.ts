import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAdminRole, requireAdmin } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { getMediaCacheStats } from "@/lib/db";
import { enforceMediaCacheBudget, mediaCacheLimitsFrom, purgeMediaCache } from "@/lib/media/remote-cache";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/admin/media_cache — cache size/queue stats and effective config.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const stats = await getMediaCacheStats(env.DB);
  // Most served entries: the eviction policy keeps these cached, so an operator
  // can see what the budget is actually protecting (30-day aging window).
  const top = await env.DB
    .prepare(
      `SELECT r2_key, target_type, size, hits, hits_at, last_hit_at FROM media_cache
       WHERE status = 'ready' AND hits > 0
       ORDER BY hits DESC LIMIT 10`
    )
    .bind()
    .all<{ r2_key: string; target_type: string; size: number; hits: number; hits_at: string | null; last_hit_at: string | null }>()
    .catch(() => ({ results: [] }));
  return json({
    stats,
    top_served: top.results ?? [],
    config: {
      enabled: limits.mediaCacheEnabled,
      days: limits.mediaCacheDays,
      profile_days: limits.mediaCacheProfileDays,
      max_bytes: limits.mediaCacheMaxBytes,
      max_object_bytes: limits.mediaCacheMaxObjectBytes,
      fetch_batch: limits.mediaCacheFetchBatch,
      user_agents: limits.mediaCacheUserAgents,
    },
  });
}

// POST /api/v1/admin/media_cache — enforce MEDIA_CACHE_MAX_BYTES right now
// (least served evicted until under budget, bounded) and report what happened. Useful
// after lowering the limit or when the cron is behind.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const result = await enforceMediaCacheBudget({ DB: env.DB, R2: env.R2, KV: env.KV }, mediaCacheLimitsFrom(limits));
  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "instance",
    targetId: "media_cache",
    action: "media_cache_enforced",
    reason: "Media cache budget enforced by an administrator.",
    confidence: null,
    model: "admin",
    details: result,
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });
  return json({ ok: true, ...result, stats: await getMediaCacheStats(env.DB) });
}

// DELETE /api/v1/admin/media_cache — purge every cached object and row.
export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }
  const removed = await purgeMediaCache({ DB: env.DB, R2: env.R2, KV: env.KV });
  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "instance",
    targetId: "media_cache",
    action: "media_cache_purged",
    reason: "Remote media cache purged by an administrator.",
    confidence: null,
    model: "admin",
    details: { removed },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });
  return json({ ok: true, removed });
}
