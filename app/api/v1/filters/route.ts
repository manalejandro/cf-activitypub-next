import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilters, createFilter, deleteFilter } from "@/lib/db";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const filters = await getFilters(env.DB, me.id);
  return json(filters.map((f) => ({
    id: f.id,
    phrase: f.title,
    context: JSON.parse(f.context) as string[],
    whole_word: true,
    expires_at: f.expires_at ?? null,
    irreversible: f.filter_action === "hide",
  })));
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const body = await request.json() as { phrase?: string; context?: string[]; irreversible?: boolean; whole_word?: boolean; expires_in?: number };
  if (!body.phrase) return json({ error: "phrase is required" }, 400);
  const id = crypto.randomUUID();
  const filterAction = body.irreversible ? "hide" : "warn";
  const context = JSON.stringify(body.context ?? ["home", "notifications", "public", "thread"]);
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;
  const { createFilterKeyword } = await import("@/lib/db");
  await createFilter(env.DB, id, me.id, body.phrase, context, filterAction, expiresAt);
  await createFilterKeyword(env.DB, crypto.randomUUID(), id, body.phrase, body.whole_word ?? true);
  return json({
    id,
    phrase: body.phrase,
    context: body.context ?? ["home", "notifications", "public", "thread"],
    whole_word: body.whole_word ?? true,
    expires_at: expiresAt,
    irreversible: body.irreversible ?? false,
  });
}
