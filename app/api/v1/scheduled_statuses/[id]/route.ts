import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { toIsoOrNull, dbTimestamp } from "@/lib/dates";
import { getAuthenticatedActor } from "@/lib/auth";
import { getScheduledStatusById, updateScheduledStatus, deleteScheduledStatus, getLicenseById } from "@/lib/db";
import { formDataToBody } from "@/lib/request-body";
import { normalizeLocationInput } from "@/lib/activitypub/utils";
import { parseEventInput } from "@/lib/event";
import { resolveLimits } from "@/lib/constants";
import { scheduledMediaAttachments, SCHEDULE_MAX_HORIZON_MS } from "@/lib/scheduled-media";
import { env } from "cloudflare:workers";

const VISIBILITIES = ["public", "unlisted", "private", "direct"];

interface ScheduledRow {
  id: string;
  actor_id: string;
  scheduled_at: string;
  params: string;
  media_ids: string | null;
}

/** `media_ids` as an array: `media_ids[]`, a JSON array, or a single id. */
function normalizeMediaIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)].filter(Boolean);
}

function parseParams(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function serializeScheduled(s: ScheduledRow): Promise<unknown> {
  return {
    id: s.id,
    scheduled_at: toIsoOrNull(s.scheduled_at) ?? new Date().toISOString(),
    params: parseParams(s.params),
    media_attachments: await scheduledMediaAttachments(env.KV, s.media_ids, s.actor_id),
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const s = await getScheduledStatusById(env.DB, id);
  if (!s) return notFound();
  if (s.actor_id !== actor.id) return notFound();

  return json(await serializeScheduled(s));
}

/**
 * Edit a scheduled status: the publish instant and/or the whole post (text,
 * visibility, CW, media, poll, location, event, license) — the same body shape
 * POST /api/v1/statuses stores when scheduling, re-validated here because the
 * publish cron trusts the stored params. Omitting a field the composer always
 * sends (visibility, media_ids…) replaces the stored value; `scheduled_at`
 * omitted keeps the current instant.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const s = await getScheduledStatusById(env.DB, id);
  if (!s) return notFound();
  if (s.actor_id !== actor.id) return notFound();

  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const contentType = request.headers.get("Content-Type") ?? "";
  let body: Record<string, unknown>;
  if (contentType.includes("application/json")) {
    body = await request.json() as Record<string, unknown>;
  } else {
    body = formDataToBody(await request.formData());
  }

  // Publish instant: explicit or the stored one; it must stay in the future
  // (the create path silently publishes past-dated schedules at once — for an
  // edit of an existing schedule that would be a surprise, so refuse it).
  const requestedAt = typeof body.scheduled_at === "string" ? body.scheduled_at.trim() : "";
  const scheduledAt = requestedAt || (toIsoOrNull(s.scheduled_at) ?? "");
  const schedDate = new Date(scheduledAt);
  if (!scheduledAt || Number.isNaN(schedDate.getTime()) || schedDate <= new Date()) {
    return json({ error: "scheduled_at must be a valid future date", error_code: "scheduled_error_past" }, 422);
  }
  // Same horizon as the create path — but only for a NEWLY requested instant:
  // a schedule created before the cap existed keeps its stored date editable
  // (its media reservations were extended under the old contract; the cap
  // protects the new ones).
  if (requestedAt && schedDate.getTime() - Date.now() > SCHEDULE_MAX_HORIZON_MS) {
    return json({ error: "scheduled_at is too far in the future (30 days max)", error_code: "scheduled_error_horizon" }, 422);
  }

  // Content limits mirror the create route: the stored params are published
  // verbatim by the cron, so anything invalid must not get in here. A
  // non-string `status` must never reach the merge below — the publish cron
  // would trip over it on every tick.
  if (body.status !== undefined && typeof body.status !== "string") {
    return json({ error: "Validation failed: Text must be a string" }, 422);
  }
  const status = typeof body.status === "string" ? body.status : "";
  if (status.length > limits.maxStatusChars) {
    return json({ error: `Validation failed: Text must be ${limits.maxStatusChars} characters or less` }, 422);
  }
  if (body.visibility !== undefined && (typeof body.visibility !== "string" || !VISIBILITIES.includes(body.visibility))) {
    return json({ error: "Invalid visibility" }, 422);
  }
  if (body.location !== undefined && body.location !== null && normalizeLocationInput(body.location) === undefined) {
    return json({ error: "Invalid location", error_code: "compose_error_location" }, 422);
  }
  if (body.event !== undefined && body.event !== null) {
    const eventResult = parseEventInput(body.event);
    if ("error" in eventResult) return json({ error: "Invalid event", error_code: eventResult.error }, 422);
  }
  if (typeof body.license === "string" && body.license.trim()) {
    const license = await getLicenseById(env.DB, body.license.trim());
    if (!license) return json({ error: "Unknown license", error_code: "compose_error_license" }, 422);
  }
  const pollRaw = body.poll as { options?: unknown } | null | undefined;
  if (pollRaw && typeof pollRaw === "object" && Array.isArray(pollRaw.options)) {
    if ((pollRaw.options as unknown[]).length > limits.maxPollOptions) {
      return json({ error: `Validation failed: Polls can have at most ${limits.maxPollOptions} options` }, 422);
    }
  }

  // Media: cap, ownership (a guessed id must not attach somebody else's
  // upload), and re-extend the pending-upload TTL to the schedule horizon —
  // the same contract the create path establishes when scheduling. When the
  // body omits `media_ids` (a Mastodon-shaped reschedule sends ONLY
  // `scheduled_at`), the stored reservations are kept and re-validated.
  const storedParams = parseParams(s.params);
  const requestedMediaIds = normalizeMediaIds(
    body.media_ids !== undefined ? body.media_ids : storedParams.media_ids
  ).slice(0, limits.maxMediaAttachments);
  const ownedMediaIds: string[] = [];
  for (const mediaId of requestedMediaIds) {
    const pendingRaw = await env.KV.get(`pending_media:${mediaId}`).catch(() => null);
    if (!pendingRaw) continue;
    try {
      const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
      if (typeof pending.actorId === "string" && pending.actorId !== actor.id) continue;
      // Stamp the horizon INSIDE the entry: the description flush
      // (PUT /api/v1/media/:id) rewrites the reservation and must not collapse
      // a 30-day TTL back to the 1-hour default of an unattached upload.
      pending.expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
      await env.KV.put(`pending_media:${mediaId}`, JSON.stringify(pending), { expirationTtl: 30 * 86400 }).catch(() => {});
    } catch { continue; }
    ownedMediaIds.push(mediaId);
  }

  // Merge over the stored params (never replace): a reschedule-only PUT keeps
  // the text/visibility/poll/event/location/license, and fields the editor
  // does resend override the stored ones (an explicit null clears them).
  const nextParams: Record<string, unknown> = { ...storedParams, ...body, scheduled_at: scheduledAt };
  if (storedParams.media_ids !== undefined || body.media_ids !== undefined) {
    nextParams.media_ids = ownedMediaIds;
  }
  const normalizedScheduledAt = dbTimestamp(schedDate);
  await updateScheduledStatus(
    env.DB,
    id,
    normalizedScheduledAt,
    JSON.stringify(nextParams),
    ownedMediaIds.length > 0 ? JSON.stringify(ownedMediaIds) : null
  );

  const updated = await getScheduledStatusById(env.DB, id);
  if (!updated) return notFound();
  return json(await serializeScheduled(updated));
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const s = await getScheduledStatusById(env.DB, id);
  if (!s) return notFound();
  if (s.actor_id !== actor.id) return notFound();

  await deleteScheduledStatus(env.DB, id);
  return json({});
}
