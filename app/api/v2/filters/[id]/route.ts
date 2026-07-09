import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterById, updateFilter, deleteFilter, getFilterKeywords, getFilterStatuses } from "@/lib/db";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const filter = await getFilterById(env.DB, id);
  if (!filter) return notFound();
  if (filter.actor_id !== actor.id) return notFound();

  const [keywords, statuses] = await Promise.all([
    getFilterKeywords(env.DB, id),
    getFilterStatuses(env.DB, id),
  ]);

  return json({
    id: filter.id,
    title: filter.title,
    context: JSON.parse(filter.context),
    expires_at: filter.expires_at,
    filter_action: filter.filter_action,
    keywords,
    statuses,
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const filter = await getFilterById(env.DB, id);
  if (!filter) return notFound();
  if (filter.actor_id !== actor.id) return notFound();

  const contentType = request.headers.get("Content-Type") ?? "";
  let title: string | undefined;
  let context: string[] | undefined;
  let filterAction: string | undefined;
  let expiresIn: number | null | undefined;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    if (body.title !== undefined) title = body.title as string;
    if (body.context !== undefined) context = body.context as string[];
    if (body.filter_action !== undefined) filterAction = body.filter_action as string;
    if (body.expires_in !== undefined) expiresIn = body.expires_in as number | null;
  } else {
    const form = await request.formData();
    const t = form.get("title");
    if (t !== null) title = t as string;
    const c = form.getAll("context[]");
    if (c.length > 0) context = c.map((v) => v.toString());
    const fa = form.get("filter_action");
    if (fa !== null) filterAction = fa as string;
    const ei = form.get("expires_in");
    if (ei !== null) expiresIn = ei ? parseInt(ei as string) : null;
  }

  const expiresAt = expiresIn !== undefined
    ? (expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null)
    : undefined;

  await updateFilter(env.DB, id, title, context ? JSON.stringify(context) : undefined, filterAction, expiresAt);

  const updated = await getFilterById(env.DB, id);
  const [keywords, statuses] = await Promise.all([
    getFilterKeywords(env.DB, id),
    getFilterStatuses(env.DB, id),
  ]);

  return json({
    id: updated!.id,
    title: updated!.title,
    context: JSON.parse(updated!.context),
    expires_at: updated!.expires_at,
    filter_action: updated!.filter_action,
    keywords,
    statuses,
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const filter = await getFilterById(env.DB, id);
  if (!filter) return notFound();
  if (filter.actor_id !== actor.id) return notFound();

  await deleteFilter(env.DB, id);
  return json({});
}
