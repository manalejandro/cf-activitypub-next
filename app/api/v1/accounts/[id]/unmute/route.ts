import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, deleteMute } from "@/lib/db";
import { buildRelationship } from "@/lib/mastodon/relationships";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const target = await getActorById(env.DB, id);
  if (!target) return notFound();

  await deleteMute(env.DB, actor.id, target.id);


  return json(await buildRelationship(env.DB, actor.id, target.id));
}
