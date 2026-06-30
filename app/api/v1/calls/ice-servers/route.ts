/**
 * GET /api/v1/calls/ice-servers
 *
 * Returns ICE server configuration (STUN + TURN) for WebRTC.
 *
 * Primary: fetches TURN+STUN credentials from the Cloudflare Calls API
 * using CALLS_TURN_KEY_ID / CALLS_API_TOKEN secrets.
 *
 * Fallback: if the API is unavailable or credentials are missing, returns
 * public STUN-only servers so peer-to-peer connections (no TURN relay)
 * can still be attempted.
 */

import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

const FALLBACK_STUN: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

type RTCIceServer = { urls: string | string[]; username?: string; credential?: string };

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  if (env.CALLS_TURN_KEY_ID && env.CALLS_API_TOKEN) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CALLS_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CALLS_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 86400 }),
        }
      );

      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        const raw: RTCIceServer[] = (data.iceServers as RTCIceServer[] | undefined) ?? [];
        console.log(`[ice-servers] raw Cloudflare response: ${JSON.stringify(data).substring(0, 500)}`);

        // Normalize: ensure each URL is a separate entry for maximum browser
        // compatibility (some WebRTC stacks reject arrays with mixed STUN/TURN).
        const iceServers: RTCIceServer[] = [];
        for (const server of raw) {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          for (const url of urls) {
            const entry: RTCIceServer = { urls: url };
            if (server.username) entry.username = server.username;
            if (server.credential) entry.credential = server.credential;
            // preserve credentialType if present (Cloudflare uses "password")
            if ((server as Record<string, unknown>).credentialType) {
              (entry as Record<string, unknown>).credentialType = (server as Record<string, unknown>).credentialType;
            }
            iceServers.push(entry);
          }
        }

        console.log(`[ice-servers] normalized: ${JSON.stringify(iceServers).substring(0, 500)}`);

        if (iceServers.length > 0) {
          return json({ iceServers });
        }
      } else {
        const body = await res.text().catch(() => "(no body)");
        console.error(`Cloudflare Calls API error: ${res.status} ${res.statusText} — ${body}`);
      }
    } catch (err) {
      console.error("Cloudflare Calls API fetch failed:", err);
    }
  }

  return json({ iceServers: FALLBACK_STUN });
}
