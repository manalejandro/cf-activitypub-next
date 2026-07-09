import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getLists } from "@/lib/db";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const lists = await getLists(env.DB, actor.id);
  return json(lists);
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";
  let title = "";
  let repliesPolicy = "list";
  let exclusive = false;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    title = (body.title as string) ?? "";
    repliesPolicy = (body.replies_policy as string) ?? "list";
    exclusive = Boolean(body.exclusive);
  } else {
    const form = await request.formData();
    title = (form.get("title") as string) ?? "";
    repliesPolicy = (form.get("replies_policy") as string) ?? "list";
    exclusive = (form.get("exclusive") as string) === "true";
  }

  if (!title) {
    return json({ error: "title is required" }, 422);
  }

  const { createList } = await import("@/lib/db");
  const { generateId } = await import("@/lib/activitypub/utils");
  const id = generateId();
  await createList(env.DB, id, actor.id, title, repliesPolicy, exclusive);

  return json({ id, title, replies_policy: repliesPolicy, exclusive });
}