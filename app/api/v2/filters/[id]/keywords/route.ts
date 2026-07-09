import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterById, getFilterKeywords, createFilterKeyword } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const filter = await getFilterById(env.DB, id);
  if (!filter) return notFound();
  if (filter.actor_id !== actor.id) return notFound();

  const keywords = await getFilterKeywords(env.DB, id);
  return json(keywords);
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

  const keywordId = generateId();
  await createFilterKeyword(env.DB, keywordId, filterId, keyword, wholeWord);

  return json({ id: keywordId, keyword, whole_word: wholeWord });
}
