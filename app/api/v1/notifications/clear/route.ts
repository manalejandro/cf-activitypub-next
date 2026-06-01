import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { markNotificationsRead } from "@/lib/db";
import type { NextRequest } from "next/server";

// POST /api/v1/notifications/clear  (Mastodon compat — marks all as read)
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  await markNotificationsRead(env.DB, actor.id);
  return json({});
}
