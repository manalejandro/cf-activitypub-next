import { type NextRequest } from "next/server";
import { json, unauthorized, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { updatePushPresence } from "@/lib/db";
import { env } from "cloudflare:workers";

// How long a presence heartbeat is valid. The client renews it every 4
// minutes while the tab is focused; beats that still leave more than half the
// horizon covered skip the D1 write entirely (see updatePushPresence), so an
// endpoint costs ~one row write every 8 minutes instead of one per beat. The
// trade: a CRASHED tab (no clean blur/pagehide) starts receiving push within
// ~15 minutes instead of 2 — a release on blur/pagehide stays immediate.
const PRESENCE_TTL_SECONDS = 900;

// POST /api/v1/push/presence — the focused tab reports itself so the server
// skips Web Push for that device (the in-app streaming event still updates the
// UI). `active: false` (blur/hide/pagehide) releases it immediately.
export async function POST(request: NextRequest): Promise<Response> {

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

  if (body.active === true) {
    const presentUntil = new Date(Date.now() + PRESENCE_TTL_SECONDS * 1000).toISOString();
    const freshCutoff = new Date(Date.now() + PRESENCE_TTL_SECONDS * 500).toISOString();
    await updatePushPresence(env.DB, me.id, endpoint, presentUntil, freshCutoff);
  } else {
    await updatePushPresence(env.DB, me.id, endpoint, null);
  }
  return json({});
}
