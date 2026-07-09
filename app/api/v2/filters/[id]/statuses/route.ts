import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterById, getFilterStatuses, createFilterStatus } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const filter = await getFilterById(env.DB, id);
  if (!filter) return notFound();
  if (filter.actor_id !== actor.id) return notFound();

  const statuses = await getFilterStatuses(env.DB, id);
  return json(statuses);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const filter = await getFilterById(env.DB, id);
  if (!filter) return notFound();
  if (filter.actor_id !== actor.id) return notFound();
  const filterId = id;

  const contentType = request.headers.get("Content-Type") ?? "";
  let statusId = "";

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, string>;
    statusId = body.status_id ?? "";
  } else {
    const form = await request.formData();
    statusId = (form.get("status_id") as string) ?? "";
  }

  if (!statusId) return json({ error: "status_id is required" }, 422);

  const statusFilterId = generateId();
  await createFilterStatus(env.DB, statusFilterId, filterId, statusId);

  return json({ id: statusFilterId, status_id: statusId });
}
