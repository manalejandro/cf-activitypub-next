import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterById, updateFilter, deleteFilter, getFilterKeywords } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const filter = await getFilterById(env.DB, id);
  if (!filter || filter.actor_id !== me.id) return notFound();
  return json({
    id: filter.id,
    phrase: filter.title,
    context: JSON.parse(filter.context) as string[],
    whole_word: true,
    expires_at: filter.expires_at ?? null,
    irreversible: filter.filter_action === "hide",
  });
}

export async function PUT(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const existing = await getFilterById(env.DB, id);
  if (!existing || existing.actor_id !== me.id) return notFound();
  const body = await _request.json() as { phrase?: string; context?: string[]; irreversible?: boolean; whole_word?: boolean; expires_in?: number };
  const expiresAt = body.expires_in !== undefined ? (body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null) : undefined;
  await updateFilter(env.DB, id, body.phrase, body.context ? JSON.stringify(body.context) : undefined, body.irreversible !== undefined ? (body.irreversible ? "hide" : "warn") : undefined, expiresAt as string | null | undefined);
  const updated = await getFilterById(env.DB, id);
  if (!updated) return notFound();
  return json({
    id: updated.id,
    phrase: updated.title,
    context: JSON.parse(updated.context) as string[],
    whole_word: true,
    expires_at: updated.expires_at ?? null,
    irreversible: updated.filter_action === "hide",
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  const existing = await getFilterById(env.DB, id);
  if (!existing || existing.actor_id !== me.id) return notFound();
  await deleteFilter(env.DB, id);
  return json({});
}
