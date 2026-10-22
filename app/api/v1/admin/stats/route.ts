// Instance statistics for the admin panel: the same public status (components
// plus counters) and the operator's view on top — database size and row counts,
// storage retention, the federation registry, delivery failures, the media
// cache with its effective limits, moderation counters, the cron's last run and
// which optional features are configured. Computed per request: an operator
// opening the panel wants today's numbers, not a minute-old copy.
import { type NextRequest } from "next/server";
import { env } from "cloudflare:workers";
import { json } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import { getInstanceStatsSnapshot } from "@/lib/instance-stats";

// GET /api/v1/admin/stats
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const snapshot = await getInstanceStatsSnapshot(env);
  return json(snapshot);
}
