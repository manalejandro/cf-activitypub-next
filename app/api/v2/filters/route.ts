// GET /api/v2/filters — list the current user's filter groups
// POST /api/v2/filters — create a filter group (Mastodon 4.0+ v2 API)
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import {
  getAllFiltersForAccount,
  insertFilter,
  insertFilterKeyword,
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

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const filters = await getAllFiltersForAccount(env.DB, actor.id);
  const result = await Promise.all(filters.map((f) => loadFilterWithAssociations(env.DB, f)));
  return json(result);
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

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

  const title = (body.title as string | undefined)?.trim() ?? "";
  if (!title) return badRequest("Validation failed: Title can't be blank");

  const contextRaw = body.context;
  let context: FilterContext[];
  if (Array.isArray(contextRaw)) {
    context = (contextRaw as string[]).filter((c): c is FilterContext => FILTER_CONTEXTS.includes(c as FilterContext));
  } else {
    // form-encoded: context[]=home&context[]=public
    const arr: string[] = [];
    for (let i = 0; i < 10; i++) {
      const v = body[`context[${i}]`];
      if (v === undefined) break;
      arr.push(String(v));
    }
    context = arr.filter((c): c is FilterContext => FILTER_CONTEXTS.includes(c as FilterContext));
  }
  if (context.length === 0) return badRequest("Validation failed: Context can't be blank, Context None or invalid context supplied");

  const actionRaw = (body.filter_action as string | undefined) ?? "warn";
  const action: FilterAction = FILTER_ACTIONS.includes(actionRaw as FilterAction) ? actionRaw as FilterAction : "warn";

  let expiresAt: string | null = null;
  if (body.expires_in !== undefined && body.expires_in !== null && body.expires_in !== "") {
    const seconds = Number(body.expires_in);
    if (!Number.isFinite(seconds) || seconds <= 0) return badRequest("Validation failed: Expires in is invalid");
    expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  }

  const keywords = parseKeywordsAttributes(body);

  const filterId = generateId();
  await insertFilter(env.DB, {
    id: filterId,
    accountId: actor.id,
    title: title.slice(0, 256),
    action,
    context: JSON.stringify(context),
    expiresAt,
  });

  for (const k of keywords) {
    await insertFilterKeyword(env.DB, { id: generateId(), customFilterId: filterId, keyword: k.keyword, wholeWord: k.whole_word });
  }

  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});

  const row = await getAllFiltersForAccount(env.DB, actor.id).then((rs) => rs.find((r) => r.id === filterId) ?? null);
  if (!row) return json({ id: filterId }, 201);
  return json(await loadFilterWithAssociations(env.DB, row), 201);
}