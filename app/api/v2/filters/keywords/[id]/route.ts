// GET /api/v2/filters/keywords/:id — view one keyword
// PUT /api/v2/filters/keywords/:id — edit a keyword
// DELETE /api/v2/filters/keywords/:id — delete a keyword
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterKeywordById, getFilterById, updateFilterKeyword, deleteFilterKeyword } from "@/lib/db";
import { broadcastFiltersChanged } from "@/lib/streaming/broadcast";
import { serializeFilterKeyword } from "@/lib/mastodon/filters";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const keyword = await getFilterKeywordById(env.DB, id);
  if (!keyword) return notFound("Record not found");
  const filter = await getFilterById(env.DB, keyword.customFilterId, actor.id);
  if (!filter) return notFound("Record not found");

  return json(serializeFilterKeyword({ id: keyword.id, keyword: keyword.keyword, whole_word: keyword.wholeWord }));
}

export async function PUT(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const keyword = await getFilterKeywordById(env.DB, id);
  if (!keyword) return notFound("Record not found");
  const filter = await getFilterById(env.DB, keyword.customFilterId, actor.id);
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

  const text = (body.keyword as string | undefined)?.trim() ?? "";
  if (!text) return badRequest("Validation failed: Keyword can't be blank");
  const wholeWord = body.whole_word === "true" || body.whole_word === true;

  await updateFilterKeyword(env.DB, id, text.slice(0, 512), wholeWord);
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});

  return json(serializeFilterKeyword({ id, keyword: text.slice(0, 512), whole_word: wholeWord }));
}

export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const keyword = await getFilterKeywordById(env.DB, id);
  if (!keyword) return notFound("Record not found");
  const filter = await getFilterById(env.DB, keyword.customFilterId, actor.id);
  if (!filter) return notFound("Record not found");

  await deleteFilterKeyword(env.DB, id);
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});
  return json({});
}