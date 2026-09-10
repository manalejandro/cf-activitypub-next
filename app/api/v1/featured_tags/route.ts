import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFeaturedTags, createFeaturedTag } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";
import { resolveLimits } from "@/lib/constants";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const tags = await getFeaturedTags(env.DB, actor.id);

  const result = tags.map((t) => ({
    id: t.id,
    name: t.tag_name,
    url: `https://${domain}/tags/${t.tag_name}`,
    statuses_count: 0,
    last_status_at: null,
  }));

  return json(result);
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";
  let name = "";

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, string>;
    name = body.name ?? "";
  } else {
    const form = await request.formData();
    name = (form.get("name") as string) ?? "";
  }

  if (!name) return json({ error: "name is required" }, 422);
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const tag = name.replace(/^#+/, "").trim();
  if (!tag) return json({ error: "name is required" }, 422);
  if (tag.length > limits.maxFeaturedTagNameChars) {
    return json({ error: `name is too long (max ${limits.maxFeaturedTagNameChars} chars)` }, 422);
  }
  const existing = await getFeaturedTags(env.DB, actor.id);
  if (existing.length >= limits.maxFeaturedTags) {
    return json({ error: `Too many featured tags (max ${limits.maxFeaturedTags})` }, 422);
  }

  const id = generateId();
  await createFeaturedTag(env.DB, id, actor.id, tag.toLowerCase());

  return json({
    id,
    name: tag.toLowerCase(),
    url: `https://${domain}/tags/${tag.toLowerCase()}`,
    statuses_count: 0,
    last_status_at: null,
  });
}