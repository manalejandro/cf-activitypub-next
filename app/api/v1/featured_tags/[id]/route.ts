import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getFeaturedTagById, deleteFeaturedTag } from "@/lib/db";
import { deliverFeaturedChange, featuredTagObject } from "@/lib/activitypub/featured";
import { getBaseUrl } from "@/lib/cf";
import { env } from "cloudflare:workers";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const tag = await getFeaturedTagById(env.DB, id);
  if (!tag) return notFound();
  if (tag.actor_id !== actor.id) return notFound();

  await deleteFeaturedTag(env.DB, id);
  await deliverFeaturedChange(env, actor, featuredTagObject(getBaseUrl(env), tag.tag_name), "Remove", "tags");
  return json({});
}