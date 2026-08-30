// GET /api/v2/filters/:id — view one filter group
// PUT /api/v2/filters/:id — update a filter group (keywords_attributes support)
// DELETE /api/v2/filters/:id — delete a filter group
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import {
  getFilterById,
  updateFilter,
  deleteFilter,
  deleteFilterKeyword,
  insertFilterKeyword,
  getFilterKeywords,
  getAllFiltersForAccount,
} from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastFiltersChanged } from "@/lib/streaming/broadcast";
import {
  FILTER_ACTIONS,
  FILTER_CONTEXTS,
  loadFilterWithAssociations,
  parseKeywordsAttributes,
  type FilterAction,
  type FilterContext,
} from "@/lib/mastodon/filters";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const row = await getFilterById(env.DB, id, actor.id);
  if (!row) return notFound("Record not found");

  return json(await loadFilterWithAssociations(env.DB, row));
}

export async function PUT(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const row = await getFilterById(env.DB, id, actor.id);
  if (!row) return notFound("Record not found");

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

  const updates: { title?: string; action?: string; context?: string; expiresAt?: string | null } = {};

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return badRequest("Validation failed: Title can't be blank");
    updates.title = title.slice(0, 256);
  }

  if (body.context !== undefined) {
    let context: FilterContext[];
    if (Array.isArray(body.context)) {
      context = (body.context as string[]).filter((c): c is FilterContext => FILTER_CONTEXTS.includes(c as FilterContext));
    } else {
      const arr: string[] = [];
      for (let i = 0; i < 10; i++) {
        const v = body[`context[${i}]`];
        if (v === undefined) break;
        arr.push(String(v));
      }
      context = arr.filter((c): c is FilterContext => FILTER_CONTEXTS.includes(c as FilterContext));
    }
    if (context.length === 0) return badRequest("Validation failed: Context can't be blank, Context None or invalid context supplied");
    updates.context = JSON.stringify(context);
  }

  if (body.filter_action !== undefined) {
    const action = String(body.filter_action);
    updates.action = FILTER_ACTIONS.includes(action as FilterAction) ? action : "warn";
  }

  if (body.expires_in !== undefined) {
    if (body.expires_in === null || body.expires_in === "") {
      updates.expiresAt = null;
    } else {
      const seconds = Number(body.expires_in);
      if (!Number.isFinite(seconds) || seconds <= 0) return badRequest("Validation failed: Expires in is invalid");
      updates.expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    }
  }

  // Keywords: replace-and-destroy via keywords_attributes (Mastodon semantics).
  // Each entry either carries an existing `id` (edit or `_destroy`=true) or a
  // bare `keyword` (create). We rebuild the keyword list from scratch.
  if (body.keywords_attributes !== undefined || contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart")) {
    const newKeywords = parseKeywordsAttributes(body);
    const currentKeywords = await getFilterKeywords(env.DB, [id]);
    for (const k of currentKeywords) {
      await deleteFilterKeyword(env.DB, k.id);
    }
    for (const k of newKeywords) {
      await insertFilterKeyword(env.DB, { id: generateId(), customFilterId: id, keyword: k.keyword, wholeWord: k.whole_word });
    }
  }

  await updateFilter(env.DB, id, actor.id, updates);
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});

  const updated = await getAllFiltersForAccount(env.DB, actor.id).then((rs) => rs.find((r) => r.id === id));
  if (!updated) return notFound("Record not found");
  return json(await loadFilterWithAssociations(env.DB, updated));
}

export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const row = await getFilterById(env.DB, id, actor.id);
  if (!row) return notFound("Record not found");

  await deleteFilter(env.DB, id, actor.id);
  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});
  return json({});
}