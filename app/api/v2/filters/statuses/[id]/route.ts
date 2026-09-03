// GET /api/v2/filters/statuses/:id — view one status filter
// DELETE /api/v2/filters/statuses/:id — remove a status from a filter group
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterStatusById, getFilterById, deleteFilterStatus } from "@/lib/db";
import { broadcastFiltersChanged } from "@/lib/streaming/broadcast";
import { serializeFilterStatus } from "@/lib/mastodon/filters";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const status = await getFilterStatusById(env.DB, id);
  if (!status) return notFound("Record not found");
  const filter = await getFilterById(env.DB, status.customFilterId, actor.id);
  if (!filter) return notFound("Record not found");

  return json(serializeFilterStatus({ id: status.id, status_id: status.statusId }));
}

export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const status = await getFilterStatusById(env.DB, id);
  if (!status) return notFound("Record not found");
  const filter = await getFilterById(env.DB, status.customFilterId, actor.id);
  if (!filter) return notFound("Record not found");

  await deleteFilterStatus(env.DB, id);
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});
  return json({});
}