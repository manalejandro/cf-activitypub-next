// Instance status: the state of this server's components (web, database,
// federation, delivery, media cache, streaming, maintenance) plus the public
// counters. Everything here is already public elsewhere — the instance
// endpoint exposes the same kind of figures — and the payload is cached in KV
// for a minute so a status-page refresh loop never re-runs the counts.
// The page's manual refresh button sends `?fresh=1`, which bypasses the cached
// snapshot behind a GLOBAL 15-second recomputation lock: however many visitors
// click, the expensive counts re-run at most four times a minute, and clicks
// inside the lock window are served the just-refreshed snapshot.
import { type NextRequest } from "next/server";
import { env } from "cloudflare:workers";
import { getInstanceStatus } from "@/lib/instance-stats";

/** The snapshot every visitor of the status page sees, cached in KV. */
const STATUS_CACHE_KEY = "status:snapshot";
const STATUS_CACHE_TTL = 60;
/**
 * Global manual-refresh throttle. Stored as an epoch-ms value (not a TTL):
 * KV expirations have a 60-second floor, and the lock window is shorter.
 */
const STATUS_FRESH_LOCK_KEY = "status:fresh_lock";
const STATUS_FRESH_LOCK_MS = 15_000;

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  // The refresh button must never be answered from a browser cache: its whole
  // purpose is a new snapshot.
  "Cache-Control": "no-store",
};

// GET /api/v1/status
export async function GET(request: NextRequest): Promise<Response> {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";

  if (fresh) {
    const lockAt = Number((await env.KV.get(STATUS_FRESH_LOCK_KEY).catch(() => null)) ?? 0);
    if (Number.isFinite(lockAt) && Date.now() - lockAt < STATUS_FRESH_LOCK_MS) {
      // Somebody refreshed moments ago: that snapshot is fresh enough.
      const locked = await env.KV.get(STATUS_CACHE_KEY).catch(() => null);
      if (locked) return new Response(locked, { headers: HEADERS });
    } else {
      // A concurrent double recomputation is harmless and needs no atomicity:
      // both write the same shape and the lock bounds the rate anyway.
      await env.KV.put(STATUS_FRESH_LOCK_KEY, String(Date.now())).catch(() => {});
    }
  } else {
    const cached = await env.KV.get(STATUS_CACHE_KEY).catch(() => null);
    if (cached) return new Response(cached, { headers: HEADERS });
  }

  const snapshot = await getInstanceStatus(env);
  const body = JSON.stringify(snapshot);
  await env.KV.put(STATUS_CACHE_KEY, body, { expirationTtl: STATUS_CACHE_TTL }).catch(() => {});
  return new Response(body, { headers: HEADERS });
}
