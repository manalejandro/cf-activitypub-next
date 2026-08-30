// GET /api/v2/filters/:filter_id/statuses — list statuses in a filter group
// POST /api/v2/filters/:filter_id/statuses — add a status to a filter group
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterById, getFilterStatuses, insertFilterStatus } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastFiltersChanged } from "@/lib/streaming/broadcast";
import { serializeFilterStatus } from "@/lib/mastodon/filters";

type RouteParams = { params: Promise<{ filter_id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { filter_id } = await params;
  const filter = await getFilterById(env.DB, filter_id, actor.id);
  if (!filter) return notFound("Record not found");

  const statuses = await getFilterStatuses(env.DB, [filter.id]);
  return json(statuses.map((s) => serializeFilterStatus({ id: s.id, status_id: s.statusId })));
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { filter_id } = await params;
  const filter = await getFilterById(env.DB, filter_id, actor.id);
  if (!filter) return notFound("Record not found");

  const contentType = request.headers.get("Content-Type") ?? "";
  let body: Record<string, unknown> = {};
  try {
    if (contentType.includes("application/json")) {
      body = await request.json() as Record<string, unknown>;
    } else {
      const form = await request.formData();
      body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    }
  } catch {
    return badRequest("Invalid request body");
  }

  const statusId = (body.status_id as string | undefined)?.trim() ?? "";
  if (!statusId) return badRequest("Validation failed: Status can't be blank");

  const id = generateId();
  await insertFilterStatus(env.DB, { id, customFilterId: filter.id, statusId });
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});

  return json(serializeFilterStatus({ id, status_id: statusId }));
}