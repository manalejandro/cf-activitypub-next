import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { toIsoOrNull } from "@/lib/dates";
import { getAuthenticatedActor } from "@/lib/auth";
import { getScheduledStatuses } from "@/lib/db";
import { clampLimit, resolveLimits } from "@/lib/constants";
import { scheduledMediaAttachments } from "@/lib/scheduled-media";
import { env } from "cloudflare:workers";

export async function GET(request: NextRequest): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = clampLimit(request.nextUrl.searchParams.get("limit"), limits.defaultTimelinePage, limits.maxPageSize);
  const statuses = await getScheduledStatuses(env.DB, actor.id, limit);

  // Mastodon's shape carries the reserved media as attachment entities; they
  // live in the pending_media KV reservations until the cron publishes them.
  const result = await Promise.all(
    statuses.map(async (s) => ({
      id: s.id,
      scheduled_at: toIsoOrNull(s.scheduled_at) ?? new Date().toISOString(),
      params: (() => { try { return JSON.parse(s.params); } catch { return {}; } })(),
      media_attachments: await scheduledMediaAttachments(env.KV, s.media_ids, actor.id),
    }))
  );

  return json(result);
}