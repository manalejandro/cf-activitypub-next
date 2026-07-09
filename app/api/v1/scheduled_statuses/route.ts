import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getScheduledStatuses } from "@/lib/db";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "20"), 40);
  const statuses = await getScheduledStatuses(env.DB, actor.id, limit);

  const result = statuses.map((s) => ({
    id: s.id,
    scheduled_at: s.scheduled_at,
    params: (() => { try { return JSON.parse(s.params); } catch { return {}; } })(),
    media_attachments: [],
  }));

  return json(result);
}