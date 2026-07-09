import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, deleteMute, getFollow } from "@/lib/db";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const target = await getActorById(env.DB, id);
  if (!target) return notFound();

  await deleteMute(env.DB, actor.id, target.id);

  const follows = await getFollow(env.DB, actor.id, target.id);

  return json({
    id: target.id,
    following: follows?.state === "accepted" || false,
    followed_by: null,
    blocking: false,
    blocked_by: null,
    muting: false,
    muting_notifications: false,
    requested: false,
    domain_blocking: false,
    showing_reblogs: true,
    endorsed: false,
    notifying: false,
    note: "",
  });
}
