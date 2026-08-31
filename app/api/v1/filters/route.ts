// Legacy Mastodon v1 filters API (compatibility). One V1::Filter per keyword.
// GET /api/v1/filters — list all keywords across the user's filter groups
// POST /api/v1/filters — create a filter group with a single keyword
import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getAllFiltersForAccount, getFilterKeywords, insertFilter, insertFilterKeyword } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastFiltersChanged } from "@/lib/streaming/broadcast";
import { parseFilterContexts } from "@/lib/mastodon/filters";
import { MAX_FILTER_TITLE_CHARS, MAX_FILTER_KEYWORD_CHARS } from "@/lib/constants";

export interface V1Filter {
  id: string;
  phrase: string;
  context: string[];
  whole_word: boolean;
  expires_at: string | null;
  irreversible: boolean;
}

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const filters = await getAllFiltersForAccount(env.DB, actor.id);
  const result: V1Filter[] = [];
  for (const f of filters) {
    const keywords = await getFilterKeywords(env.DB, [f.id]);
    for (const k of keywords) {
      result.push({
        id: k.id,
        phrase: k.keyword,
        context: parseFilterContexts(f.context),
        whole_word: k.wholeWord,
        expires_at: f.expiresAt,
        irreversible: f.action === "hide",
      });
    }
  }
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

  const phrase = (body.phrase as string | undefined)?.trim() ?? "";
  if (!phrase) return badRequest("Validation failed: Phrase can't be blank");

  const contextRaw = body.context;
  let context: string[];
  if (Array.isArray(contextRaw)) {
    context = (contextRaw as string[]).filter((c) => ["home", "notifications", "public", "thread", "account"].includes(c));
  } else {
    const arr: string[] = [];
    for (let i = 0; i < 10; i++) {
      const v = body[`context[${i}]`];
      if (v === undefined) break;
      arr.push(String(v));
    }
    context = arr.filter((c) => ["home", "notifications", "public", "thread", "account"].includes(c));
  }
  if (context.length === 0) return badRequest("Validation failed: Context can't be blank, Context None or invalid context supplied");

  const wholeWord = body.whole_word === "true" || body.whole_word === true;
  const irreversible = body.irreversible === "true" || body.irreversible === true;

  let expiresAt: string | null = null;
  if (body.expires_in !== undefined && body.expires_in !== null && body.expires_in !== "") {
    const seconds = Number(body.expires_in);
    if (Number.isFinite(seconds) && seconds > 0) {
      expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    }
  }

  const filterId = generateId();
  await insertFilter(env.DB, {
    id: filterId,
    accountId: actor.id,
    title: phrase.slice(0, MAX_FILTER_TITLE_CHARS),
    action: irreversible ? "hide" : "warn",
    context: JSON.stringify(context),
    expiresAt,
  });
  const keywordId = generateId();
  await insertFilterKeyword(env.DB, { id: keywordId, customFilterId: filterId, keyword: phrase.slice(0, MAX_FILTER_KEYWORD_CHARS), wholeWord });

  await broadcastFiltersChanged(env.TIMELINE_STREAM, actor.username).catch(() => {});

  return json({
    id: keywordId,
    phrase: phrase.slice(0, MAX_FILTER_KEYWORD_CHARS),
    context,
    whole_word: wholeWord,
    expires_at: expiresAt,
    irreversible,
  });
}