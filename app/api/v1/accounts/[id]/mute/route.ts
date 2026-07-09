import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, createMute, isMuted, getFollow } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const target = await getActorById(env.DB, id);
  if (!target) return notFound();

  const contentType = request.headers.get("Content-Type") ?? "";
  let notifications = true;
  let duration = 0;

  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    if (body.notifications !== undefined) notifications = Boolean(body.notifications);
    if (body.duration !== undefined) duration = Number(body.duration);
  } else {
    const form = await request.formData();
    const notifVal = form.get("notifications");
    if (notifVal !== null) notifications = notifVal === "true";
    const durVal = form.get("duration");
    if (durVal !== null) duration = parseInt(durVal as string) || 0;
  }

  const already = await isMuted(env.DB, actor.id, target.id);
  if (!already) {
    await createMute(env.DB, generateId(), actor.id, target.id, notifications, duration);
  }

  const follows = await getFollow(env.DB, actor.id, target.id);

  return json({
    id: target.id,
    following: follows?.state === "accepted" || false,
    followed_by: null,
    blocking: false,
    blocked_by: null,
    muting: true,
    muting_notifications: notifications,
    requested: false,
    domain_blocking: false,
    showing_reblogs: true,
    endorsed: false,
    notifying: false,
    note: "",
  });
}
