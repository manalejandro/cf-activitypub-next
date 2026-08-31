// Legacy Mastodon v1 filters API — single keyword operations.
// GET /api/v1/filters/:id — view one keyword (its parent filter group)
// PUT /api/v1/filters/:id — update phrase / whole_word
// DELETE /api/v1/filters/:id — delete the keyword (not the parent group)
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilterKeywordById, getFilterById, updateFilterKeyword, deleteFilterKeyword } from "@/lib/db";
import { broadcastFiltersChanged } from "@/lib/streaming/broadcast";
import { parseFilterContexts } from "@/lib/mastodon/filters";
import type { V1Filter } from "../route";
import { MAX_FILTER_KEYWORD_CHARS } from "@/lib/constants";

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

  const v1: V1Filter = {
    id: keyword.id,
    phrase: keyword.keyword,
    context: parseFilterContexts(filter.context),
    whole_word: keyword.wholeWord,
    expires_at: filter.expiresAt,
    irreversible: filter.action === "hide",
  };
  return json(v1);
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

  const phrase = (body.phrase as string | undefined)?.trim() ?? "";
  if (!phrase) return badRequest("Validation failed: Phrase can't be blank");
  const wholeWord = body.whole_word === "true" || body.whole_word === true;

  await updateFilterKeyword(env.DB, id, phrase.slice(0, MAX_FILTER_KEYWORD_CHARS), wholeWord);
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});

  const v1: V1Filter = {
    id,
    phrase: phrase.slice(0, MAX_FILTER_KEYWORD_CHARS),
    context: parseFilterContexts(filter.context),
    whole_word: wholeWord,
    expires_at: filter.expiresAt,
    irreversible: filter.action === "hide",
  };
  return json(v1);
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