// Instance status: the state of this server's components (web, database,
// federation, delivery, media cache, streaming, maintenance) plus the public
// counters. Everything here is already public elsewhere — the instance
// endpoint exposes the same kind of figures — and the payload is cached in KV
// for a minute so a status-page refresh loop never re-runs the counts.
import { env } from "cloudflare:workers";
import { getInstanceStatus } from "@/lib/instance-stats";

/** The snapshot every visitor of the status page sees, cached in KV. */
const STATUS_CACHE_KEY = "status:snapshot";
const STATUS_CACHE_TTL = 60;

// GET /api/v1/status
export async function GET(): Promise<Response> {
  const cached = await env.KV.get(STATUS_CACHE_KEY).catch(() => null);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  const snapshot = await getInstanceStatus(env);
  const body = JSON.stringify(snapshot);
  await env.KV.put(STATUS_CACHE_KEY, body, { expirationTtl: STATUS_CACHE_TTL }).catch(() => {});
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
