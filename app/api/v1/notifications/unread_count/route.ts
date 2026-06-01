import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getUnreadNotificationCount } from "@/lib/db";
import type { NextRequest } from "next/server";

// GET /api/v1/notifications/unread_count
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const count = await getUnreadNotificationCount(env.DB, actor.id);
  return json({ count });
}
