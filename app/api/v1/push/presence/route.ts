import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { updatePushPresence } from "@/lib/db";

// How long a presence heartbeat is valid. The client renews it every 60s while
// the tab is focused, so a crashed tab starts receiving push within two minutes.
const PRESENCE_TTL_SECONDS = 120;

// POST /api/v1/push/presence — the focused tab reports itself so the server
// skips Web Push for that device (the in-app streaming event still updates the
// UI). `active: false` (blur/hide/pagehide) releases it immediately.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();

  let body: { active?: unknown; endpoint?: unknown };
  try {
    body = await request.json() as { active?: unknown; endpoint?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint.startsWith("https://") || endpoint.length > 1024) {
    return badRequest("Invalid endpoint");
  }

  const presentUntil = body.active === true
    ? new Date(Date.now() + PRESENCE_TTL_SECONDS * 1000).toISOString()
    : null;
  await updatePushPresence(env.DB, me.id, endpoint, presentUntil);
  return json({});
}
