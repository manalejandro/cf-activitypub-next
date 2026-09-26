import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl } from "@/lib/cf";

/**
 * OSM tile proxy.
 *
 * Browsers hitting tile.openstreetmap.org directly get blocked (403 → the
 * osm.wiki/Blocked page) because the tile server wants an identifying
 * User-Agent and caching. We fetch the tile server-side with the instance UA,
 * cache it in the Workers Cache API and serve it from our own origin.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ z: string; x: string; y: string }> }
): Promise<Response> {
  const { z, x, y } = await params;
  // The client requests `{y}.png` (Leaflet's template); strip the extension.
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y.replace(/\.png$/i, ""));
  const max = 2 ** zi;
  if (
    !Number.isInteger(zi) || zi < 0 || zi > 19 ||
    !Number.isInteger(xi) || xi < 0 || xi >= max ||
    !Number.isInteger(yi) || yi < 0 || yi >= max
  ) {
    return new Response("Not found", { status: 404 });
  }

  const { env } = getCloudflareContext();
  const base = getBaseUrl(env);
  const cache = typeof caches !== "undefined"
    ? (caches as unknown as { default?: Cache }).default ?? null
    : null;
  const cacheKey = `${base}/api/map/tiles/${zi}/${xi}/${yi}.png`;
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  const version = (env as unknown as Record<string, string>).INSTANCE_VERSION ?? "0";
  const res = await fetch(`https://tile.openstreetmap.org/${zi}/${xi}/${yi}.png`, {
    headers: {
      "User-Agent": `CFActivityPub/${version} (+${base}; map tiles)`,
      Accept: "image/png,image/*;q=0.8",
      Referer: `${base}/`,
    },
  }).catch(() => null);
  if (!res || !res.ok || !res.body) {
    // Release the discarded response: unread bodies stall the in-flight fetch
    // pool ("A stalled HTTP response was canceled to prevent deadlock").
    await res?.body?.cancel().catch(() => {});
    return new Response("Tile unavailable", { status: 502 });
  }

  const contentType = res.headers.get("content-type") ?? "image/png";
  const response = new Response(res.body, {
    headers: {
      "Content-Type": contentType,
      // OSM asks clients to cache tiles; the browser and the edge both do.
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
  if (cache) await cache.put(cacheKey, response.clone()).catch(() => {});
  return response;
}
