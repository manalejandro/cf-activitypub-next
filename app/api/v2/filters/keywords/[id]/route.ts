import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterKeywordById, updateFilterKeyword, deleteFilterKeyword, getFilterById } from "@/lib/db";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const kw = await getFilterKeywordById(env.DB, id);
  if (!kw) return notFound();

  const filter = await getFilterById(env.DB, kw.filter_id);
  if (!filter || filter.actor_id !== actor.id) return notFound();

  return json({ id: kw.id, keyword: kw.keyword, whole_word: kw.whole_word });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const kw = await getFilterKeywordById(env.DB, id);
  if (!kw) return notFound();

  const filter = await getFilterById(env.DB, kw.filter_id);
  if (!filter || filter.actor_id !== actor.id) return notFound();

  const contentType = request.headers.get("Content-Type") ?? "";
  let keyword = "";
  let wholeWord = false;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    keyword = (body.keyword as string) ?? "";
    wholeWord = Boolean(body.whole_word);
  } else {
    const form = await request.formData();
    keyword = (form.get("keyword") as string) ?? "";
    wholeWord = (form.get("whole_word") as string) === "true";
  }

  if (!keyword) return json({ error: "keyword is required" }, 422);

  await updateFilterKeyword(env.DB, id, keyword, wholeWord);
  return json({ id, keyword, whole_word: wholeWord });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const kw = await getFilterKeywordById(env.DB, id);
  if (!kw) return notFound();

  const filter = await getFilterById(env.DB, kw.filter_id);
  if (!filter || filter.actor_id !== actor.id) return notFound();

  await deleteFilterKeyword(env.DB, id);
  return json({});
}
