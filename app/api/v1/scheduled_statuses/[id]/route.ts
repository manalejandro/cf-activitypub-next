import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getScheduledStatusById, updateScheduledStatus, deleteScheduledStatus } from "@/lib/db";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const s = await getScheduledStatusById(env.DB, id);
  if (!s) return notFound();
  if (s.actor_id !== actor.id) return notFound();

  return json({
    id: s.id,
    scheduled_at: s.scheduled_at,
    params: (() => { try { return JSON.parse(s.params); } catch { return {}; } })(),
    media_attachments: [],
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const s = await getScheduledStatusById(env.DB, id);
  if (!s) return notFound();
  if (s.actor_id !== actor.id) return notFound();

  const contentType = request.headers.get("Content-Type") ?? "";
  let scheduledAt = "";

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, string>;
    scheduledAt = body.scheduled_at ?? "";
  } else {
    const form = await request.formData();
    scheduledAt = (form.get("scheduled_at") as string) ?? "";
  }

  if (!scheduledAt) return json({ error: "scheduled_at is required" }, 422);

  const normalizedScheduledAt = scheduledAt.replace("T", " ").replace(/\.\d+Z$/, "");
  await updateScheduledStatus(env.DB, id, normalizedScheduledAt);

  const updated = await getScheduledStatusById(env.DB, id);
  return json({
    id: updated!.id,
    scheduled_at: updated!.scheduled_at,
    params: (() => { try { return JSON.parse(updated!.params); } catch { return {}; } })(),
    media_attachments: [],
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const s = await getScheduledStatusById(env.DB, id);
  if (!s) return notFound();
  if (s.actor_id !== actor.id) return notFound();

  await deleteScheduledStatus(env.DB, id);
  return json({});
}