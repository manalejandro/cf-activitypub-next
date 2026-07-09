import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFilters, createFilter, getFilterKeywords, getFilterStatuses } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const filters = await getFilters(env.DB, actor.id);

  const result = await Promise.all(
    filters.map(async (f) => {
      const [keywords, statuses] = await Promise.all([
        getFilterKeywords(env.DB, f.id),
        getFilterStatuses(env.DB, f.id),
      ]);
      return {
        id: f.id,
        title: f.title,
        context: JSON.parse(f.context),
        expires_at: f.expires_at,
        filter_action: f.filter_action,
        keywords,
        statuses,
      };
    })
  );

  return json(result);
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";
  let title = "";
  let context: string[] = [];
  let filterAction = "warn";
  let expiresIn: number | null = null;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    title = (body.title as string) ?? "";
    context = (body.context as string[]) ?? [];
    filterAction = (body.filter_action as string) ?? "warn";
    expiresIn = (body.expires_in as number) ?? null;
  } else {
    const form = await request.formData();
    title = (form.get("title") as string) ?? "";
    context = form.getAll("context[]").map((v) => v.toString());
    filterAction = (form.get("filter_action") as string) ?? "warn";
    const ei = form.get("expires_in");
    if (ei) expiresIn = parseInt(ei as string);
  }

  if (!title) return json({ error: "title is required" }, 422);
  if (context.length === 0) return json({ error: "context is required" }, 422);

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  const id = generateId();
  await createFilter(env.DB, id, actor.id, title, JSON.stringify(context), filterAction, expiresAt);

  return json({
    id,
    title,
    context,
    expires_at: expiresAt,
    filter_action: filterAction,
    keywords: [],
    statuses: [],
  });
}
