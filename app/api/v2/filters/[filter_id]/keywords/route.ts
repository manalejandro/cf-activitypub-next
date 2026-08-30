// GET /api/v2/filters/:filter_id/keywords — list keywords of a filter group
// POST /api/v2/filters/:filter_id/keywords — add a keyword to a filter group
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterById, getFilterKeywords, insertFilterKeyword } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastFiltersChanged } from "@/lib/streaming/broadcast";
import { serializeFilterKeyword } from "@/lib/mastodon/filters";

type RouteParams = { params: Promise<{ filter_id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { filter_id } = await params;
  const filter = await getFilterById(env.DB, filter_id, actor.id);
  if (!filter) return notFound("Record not found");

  const keywords = await getFilterKeywords(env.DB, [filter.id]);
  return json(keywords.map((k) => serializeFilterKeyword({ id: k.id, keyword: k.keyword, whole_word: k.wholeWord })));
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { filter_id } = await params;
  const filter = await getFilterById(env.DB, filter_id, actor.id);
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

  const keyword = (body.keyword as string | undefined)?.trim() ?? "";
  if (!keyword) return badRequest("Validation failed: Keyword can't be blank");
  const wholeWord = body.whole_word === "true" || body.whole_word === true;

  const id = generateId();
  await insertFilterKeyword(env.DB, { id, customFilterId: filter.id, keyword: keyword.slice(0, 512), wholeWord });
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});

  return json(serializeFilterKeyword({ id, keyword, whole_word: wholeWord }));
}