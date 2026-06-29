/**
 * GET /api/v1/calls/ice-servers
 *
 * Returns ICE server configuration (STUN + TURN) fetched from the
 * Cloudflare Calls API. Requires CALLS_APP_ID and CALLS_APP_SECRET
 * to be configured as secrets.
 */

import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

const CLOUDFLARE_CALLS_API = "https://rtc.live.cloudflare.com/v1";

type RTCIceServer = { urls: string | string[]; username?: string; credential?: string };

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET) {
    return json({ error: "Calls not configured on this server" }, 503);
  }

  const res = await fetch(
    `${CLOUDFLARE_CALLS_API}/apps/${env.CALLS_APP_ID}/turn-credentials`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CALLS_APP_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 86400 }),
    }
  );

  if (!res.ok) {
    return json({ error: "Failed to fetch ICE servers" }, 502);
  }

  const data = await res.json() as {
    iceServers?: RTCIceServer[];
    result?: { iceServers: RTCIceServer[] };
  };

  const iceServers: RTCIceServer[] = data.iceServers ?? data.result?.iceServers ?? [];

  if (iceServers.length === 0) {
    return json({ error: "No ICE servers returned" }, 502);
  }

  return json({ iceServers });
}
