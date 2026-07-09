import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterStatusById, deleteFilterStatus, getFilterById } from "@/lib/db";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const fs = await getFilterStatusById(env.DB, id);
  if (!fs) return notFound();

  const filter = await getFilterById(env.DB, fs.filter_id);
  if (!filter || filter.actor_id !== actor.id) return notFound();

  return json({ id: fs.id, status_id: fs.status_id });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const fs = await getFilterStatusById(env.DB, id);
  if (!fs) return notFound();

  const filter = await getFilterById(env.DB, fs.filter_id);
  if (!filter || filter.actor_id !== actor.id) return notFound();

  await deleteFilterStatus(env.DB, id);
  return json({});
}
