import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { requireAdmin, requireFullAdmin } from "@/lib/admin-auth";
import { getMediaCacheStats } from "@/lib/db";
import { purgeMediaCache } from "@/lib/media/remote-cache";
import { resolveLimits } from "@/lib/constants";

// GET /api/v1/admin/media_cache — cache size/queue stats and effective config.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const stats = await getMediaCacheStats(env.DB);
  return json({
    stats,
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

// DELETE /api/v1/admin/media_cache — purge every cached object and row.
export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireFullAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const removed = await purgeMediaCache({ DB: env.DB, R2: env.R2, KV: env.KV });
  return json({ ok: true, removed });
}
