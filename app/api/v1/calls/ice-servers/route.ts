/**
 * GET /api/v1/calls/ice-servers
 *
 * Returns the ICE server configuration (STUN + optional TURN) for WebRTC.
 * If Cloudflare Calls credentials are configured in env, TURN credentials
 * are fetched from the Cloudflare Calls API. Otherwise, only STUN is returned.
 */

import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

const CLOUDFLARE_CALLS_API = "https://rtc.live.cloudflare.com/v1";
const STUN_ONLY: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

type RTCIceServer = { urls: string | string[]; username?: string; credential?: string };

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  // If Cloudflare Calls credentials are available, get TURN credentials
  if (env.CALLS_APP_ID && env.CALLS_APP_SECRET) {
    try {
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
      if (res.ok) {
        const data = await res.json() as {
          iceServers?: RTCIceServer[];
          result?: { iceServers: RTCIceServer[] };
        };
        const iceServers: RTCIceServer[] =
          data.iceServers ??
          data.result?.iceServers ??
          STUN_ONLY;
        return json({ iceServers });
      }
    } catch {
      // Fall through to STUN-only fallback
    }
  }

  return json({ iceServers: STUN_ONLY });
}
