import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

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
        console.log(`[ice-servers] Cloudflare response: ${JSON.stringify(data).substring(0, 600)}`);
        const raw = data.iceServers as RTCIceServer[] | undefined;
        if (raw && raw.length > 0) {
          return json({ iceServers: raw });
        }
      } else {
        const body = await res.text().catch(() => "(no body)");
        console.error(`Cloudflare Calls API error: ${res.status} ${res.statusText} — ${body}`);
      }
    } catch (err) {
      console.error("Cloudflare Calls API fetch failed:", err);
    }
  }

  return json({ iceServers: [] });
}
