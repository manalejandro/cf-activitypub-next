import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { getAdminRole, requireAdmin } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { resolveLimits } from "@/lib/constants";
import {
  isStorageRetentionEnabled,
  maintainStorageRetention,
  readStorageRetentionStats,
  storageRetentionLimitsFrom,
} from "@/lib/storage-retention";
import { env } from "cloudflare:workers";

// GET /api/v1/admin/storage — what the instance stores and how retention is
// configured. The estimate is the prunable federated payload (remote
// public/unlisted statuses and processed activities); `database_bytes` is the
// size D1 reports for the whole database.
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const retention = storageRetentionLimitsFrom(limits);
  const stats = await readStorageRetentionStats(env);
  return json({
    enabled: isStorageRetentionEnabled(retention),
    config: {
      days: retention.days,
      max_bytes: retention.maxBytes,
      prune_batch: retention.pruneBatch,
      size_batch: retention.sizeBatch,
    },
    estimate: stats.estimate,
    last_run: stats.lastRun,
  });
}

// POST /api/v1/admin/storage — run one retention pass right now (useful after
// setting the variables, or when the cron is behind) and report what it did.
export async function POST(request: NextRequest): Promise<Response> {
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const retention = storageRetentionLimitsFrom(limits);
  if (!isStorageRetentionEnabled(retention)) {
    return json({ error: "Storage retention is disabled (DB_RETENTION_DAYS / DB_RETENTION_MAX_BYTES)" }, 400);
  }

  const run = await maintainStorageRetention(env, retention);
  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "instance",
    targetId: "storage_retention",
    action: "storage_pruned",
    reason: `Manual retention pass: ${run.objectsDeleted} status(es) and ${run.activitiesDeleted} activit(ies) deleted, ${run.bytesFreed} bytes freed.`,
    confidence: null,
    model: "admin",
    details: { ...run },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  const stats = await readStorageRetentionStats(env);
  return json({ run, estimate: stats.estimate, last_run: stats.lastRun });
}
