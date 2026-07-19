import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { updateActor } from "@/lib/db";

export async function PATCH(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();
  const body = await request.json() as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof body.display_name === "string") updates.displayName = body.display_name;
  if (typeof body.note === "string") updates.summary = body.note;
  if (typeof body.locked === "boolean") updates.manuallyApprovesFollowers = body.locked;
  if (typeof body.discoverable === "boolean") updates.discoverable = body.discoverable;
  if (typeof body.bot === "boolean") updates.isBot = body.bot;
  await updateActor(env.DB, actor.id, updates);
  const updated = await getAuthenticatedActor(request, env.DB);
  const { serializeAccount } = await import("@/lib/mastodon/serializers");
  const { getAllCustomEmojis, getActorFields } = await import("@/lib/db");
  const [emojis, fields] = await Promise.all([
    getAllCustomEmojis(env.DB),
    getActorFields(env.DB, actor.id),
  ]);
  return json(serializeAccount(updated!, domain, { isCurrentUser: true, fields, emojis }));
}
