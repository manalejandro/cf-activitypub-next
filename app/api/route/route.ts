import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json } from "@/lib/cf";
import { parseCoordinatePair, routeRequestUrls } from "@/lib/location";
import { safeFetch } from "@/lib/activitypub/federation";

/**
 * Routing proxy for the location page.
 *
 * Keeps the OSRM requests server-side: the community routing services see one
 * identified client (`CFActivityPub/<version> (+instance)`) instead of every
 * visitor, responses are cached by rounded coordinates and the visitor's
 * position is never handed to a third party. `code` is `Ok` only when a server
 * answered with a usable route; otherwise the client falls back to a straight
 * line.
 *
 * GET /api/route?profile=driving|foot&from=lat,lng&to=lat,lng
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const base = getBaseUrl(env);
  const params = new URL(request.url).searchParams;
  const profile = params.get("profile") === "foot" ? "foot" : "driving";
  const from = parseCoordinatePair(params.get("from"));
  const to = parseCoordinatePair(params.get("to"));
  if (!from || !to) return json({ error: "from and to are required as lat,lng" }, 400);

  const cache = typeof caches !== "undefined"
    ? (caches as unknown as { default?: Cache }).default ?? null
    : null;
  const cacheKey =
    `${base}/api/route?profile=${profile}` +
    `&from=${from.latitude.toFixed(5)},${from.longitude.toFixed(5)}` +
    `&to=${to.latitude.toFixed(5)},${to.longitude.toFixed(5)}`;
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  const version = (env as unknown as Record<string, string>).INSTANCE_VERSION ?? "0";
  const headers = {
    "User-Agent": `CFActivityPub/${version} (+${base}; routing)`,
    Accept: "application/json",
  };

  for (const url of routeRequestUrls(profile, from, to)) {
    // safeFetch releases the bodies of non-2xx responses; OSRM answers a 400
    // with NoSegment/NoRoute, which only means "try the next server".
    const res = await safeFetch(url, { headers }).catch(() => null);
    if (!res || !res.ok) continue;
    const body = await res.text().catch(() => "");
    let code = "";
    try {
      code = (JSON.parse(body) as { code?: string }).code ?? "";
    } catch {
      code = "";
    }
    if (code !== "Ok") continue;

    const response = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        // Routes change slowly; the browser and the edge cache both.
        "Cache-Control": "public, max-age=86400",
      },
    });
    if (cache) await cache.put(cacheKey, response.clone()).catch(() => {});
    return response;
  }

  return json({ error: "Routing unavailable" }, 502);
}
