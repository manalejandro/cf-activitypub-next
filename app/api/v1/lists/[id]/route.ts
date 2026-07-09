import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getListById, updateList, deleteList } from "@/lib/db";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();

  if (list.actor_id !== actor.id) return notFound();

  return json({
    id: list.id,
    title: list.title,
    replies_policy: list.replies_policy,
    exclusive: list.exclusive,
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();
  if (list.actor_id !== actor.id) return notFound();

  const contentType = request.headers.get("Content-Type") ?? "";
  let title: string | undefined;
  let repliesPolicy: string | undefined;
  let exclusive: boolean | undefined;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    if (body.title !== undefined) title = body.title as string;
    if (body.replies_policy !== undefined) repliesPolicy = body.replies_policy as string;
    if (body.exclusive !== undefined) exclusive = Boolean(body.exclusive);
  } else {
    const form = await request.formData();
    const t = form.get("title");
    if (t !== null) title = t as string;
    const r = form.get("replies_policy");
    if (r !== null) repliesPolicy = r as string;
    const e = form.get("exclusive");
    if (e !== null) exclusive = e === "true";
  }

  await updateList(env.DB, id, title, repliesPolicy, exclusive);

  const updated = await getListById(env.DB, id);
  return json({
    id: updated!.id,
    title: updated!.title,
    replies_policy: updated!.replies_policy,
    exclusive: updated!.exclusive,
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const list = await getListById(env.DB, id);
  if (!list) return notFound();
  if (list.actor_id !== actor.id) return notFound();

  await deleteList(env.DB, id);
  return json({});
}