import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFeaturedTags, createFeaturedTag } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";

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

  const id = generateId();
  await createFeaturedTag(env.DB, id, actor.id, name.toLowerCase());

  return json({
    id,
    name: name.toLowerCase(),
    url: `https://${domain}/tags/${name.toLowerCase()}`,
    statuses_count: 0,
    last_status_at: null,
  });
}