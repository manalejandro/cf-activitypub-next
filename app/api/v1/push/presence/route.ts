import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { pushPresenceKey } from "@/lib/push";

// How long a presence marker lives without a heartbeat. The client renews it
// every 60s while the tab is focused, so a crashed tab stops silencing push
// within two minutes.
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

  const key = await pushPresenceKey(me.id, endpoint);
  if (body.active === true) {
    await env.KV.put(key, "1", { expirationTtl: PRESENCE_TTL_SECONDS });
  } else {
    await env.KV.delete(key);
  }
  return json({});
}
