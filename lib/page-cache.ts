/**
 * Short-lived edge cache for the app's HTML pages.
 *
 * The front is a client-rendered React app: every page request re-renders a
 * shell that carries no user data (`lib` note: the HTML is byte-identical with
 * and without a session cookie — verified against production) but the framework
 * sends it with `Cache-Control: no-store` and a long `Vary` list, so **nothing**
 * was cached: every visit, reload and crawler hit the Worker.
 *
 * This module keeps those shells in the Workers Cache API with a short TTL and a
 * stale-while-revalidate window: a fresh copy is served instantly, a stale one
 * is served immediately and refreshed in the background (`ctx.waitUntil`), and a
 * missing one is rendered as usual. Nothing is cached for days — the default is
 * 60 s fresh and up to 10 min stale, both configurable
 * (`PAGE_CACHE_TTL`/`PAGE_CACHE_SWR`, 0 disables the cache).
 *
 * Why the Cache API and not the CDN: Cloudflare only honours
 * `Vary: Accept-Encoding`, and the framework's `Vary: RSC, Next-Router-*…`
 * disables the edge cache for those responses — which is the right call, since
 * serving an HTML shell to a client that asked for the RSC payload (client-side
 * navigation) breaks the app. The Cache API keys entries by URL **and** honours
 * the stored `Vary`, so HTML and RSC variants never mix.
 *
 * Never cached: RSC/navigation fetches, API and federation routes, requests
 * with an `Authorization` header (API clients), non-HTML responses, non-200s
 * and anything with `Set-Cookie`.
 */

import type { ExecutionContext } from "@cloudflare/workers-types";
import { DEFAULT_LIMITS, type InstanceLimits } from "@/lib/constants";

export interface PageCacheLimits {
  /** Seconds a cached page stays fresh before it is revalidated. */
  ttl: number;
  /** Extra seconds a stale page may be served while revalidating in the background. */
  swr: number;
}

export const DEFAULT_PAGE_CACHE_TTL = DEFAULT_LIMITS.pageCacheTtl;
export const DEFAULT_PAGE_CACHE_SWR = DEFAULT_LIMITS.pageCacheSwr;

/** Marker with the store time (seconds since epoch); stripped before serving. */
const STORED_AT_HEADER = "x-cf-ap-stored-at";
/** Observability: HIT / STALE on cached responses (MISS is just the origin). */
const CACHE_HEADER = "x-page-cache";

/** Paths that must never be cached: APIs, federation and authenticated surfaces. */
const SKIP_PREFIXES = [
  "/api/",
  "/RSC/",
  "/objects/",
  "/nodeinfo/",
  "/inbox",
  "/oauth/",
  "/authorize_interaction",
  "/.well-known/",
  "/quote_authorizations/",
  "/feature_authorizations/",
];

/** Typechecked bridge from `resolveLimits()` to this module (the worker's own contract). */
export function pageCacheLimitsFrom(limits: Pick<InstanceLimits, "pageCacheTtl" | "pageCacheSwr">): PageCacheLimits {
  return { ttl: limits.pageCacheTtl, swr: limits.pageCacheSwr };
}

/**
 * Whether this request may be served from (and stored in) the page cache. Only
 * plain HTML navigations: no RSC payload fetches (`RSC`/`Next-Router-*`
 * headers), no API paths, no API clients, no non-GET methods.
 */
export function isPageCacheRequest(request: Request, limits: PageCacheLimits): boolean {
  if (limits.ttl <= 0) return false;
  if (request.method !== "GET") return false;
  if (request.headers.get("Authorization")) return false;
  if (request.headers.get("RSC") || request.headers.get("Next-Router-Prefetch")) return false;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.searchParams.has("_rsc")) return false;
  return !SKIP_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/** A page response worth caching: a 200 HTML document nobody personalised. */
function isCacheableResponse(response: Response): boolean {
  if (response.status !== 200) return false;
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.includes("text/html")) return false;
  if (response.headers.has("Set-Cookie")) return false;
  const vary = response.headers.get("Vary") ?? "";
  // A response that varies on the cookie is personalised: never share it.
  return !/(^|,\s*)cookie(\s*,|$)/i.test(vary);
}

function storedCopy(response: Response, limits: PageCacheLimits, now: number): Response {
  const headers = new Headers(response.headers);
  // Replace the framework's `no-store` with our short public policy, and leave
  // the `Vary` in place: the Cache API honours it, so the RSC variant (if one
  // ever reaches this path) can never be served to a browser.
  headers.set("Cache-Control", `public, max-age=${limits.ttl + limits.swr}`);
  headers.set(STORED_AT_HEADER, String(now));
  headers.delete("Set-Cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function servedFromCache(stored: Response, limits: PageCacheLimits, now: number): { response: Response; stale: boolean } | null {
  const storedAt = Number.parseInt(stored.headers.get(STORED_AT_HEADER) ?? "", 10);
  if (!Number.isFinite(storedAt)) return null;
  const age = Math.max(0, now - storedAt);
  if (age > limits.ttl + limits.swr) return null;
  const headers = new Headers(stored.headers);
  headers.delete(STORED_AT_HEADER);
  headers.set(CACHE_HEADER, age > limits.ttl ? "STALE" : "HIT");
  headers.set("Age", String(age));
  // The browser gets the short freshness window, not the whole stale one.
  headers.set("Cache-Control", `public, max-age=${limits.ttl}`);
  return { response: new Response(stored.body, { status: stored.status, headers }), stale: age > limits.ttl };
}

export interface PageCacheResult {
  response: Response;
  /** How the response was answered, for headers/logs. */
  state: "HIT" | "STALE" | "MISS";
}

/**
 * Serve a page from the cache when possible and store (or revalidate) it
 * otherwise. `render` is the app handler (kept as a callback so the Worker
 * stays the only place that knows about `vinext`).
 */
export async function withPageCache(
  request: Request,
  ctx: ExecutionContext,
  limits: PageCacheLimits,
  render: () => Promise<Response>,
  now: number = Math.floor(Date.now() / 1000)
): Promise<Response> {
  if (!isPageCacheRequest(request, limits) || typeof caches === "undefined") return render();
  // `caches.default` is a Workers extension; the DOM lib's CacheStorage (loaded
  // by tsconfig) does not declare it.
  const cache = (caches as unknown as { default: Cache }).default;
  // The lookup request is normalised (method GET, no client headers) so entries
  // are shared by every visitor of the same URL; the stored `Vary` still keeps
  // variants apart.
  const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });

  const stored = await cache.match(cacheKey).catch(() => undefined);
  if (stored) {
    const hit = servedFromCache(stored, limits, now);
    if (hit) {
      if (hit.stale) {
        // Serve the stale shell now and refresh it in the background.
        ctx.waitUntil(
          render()
            .then((fresh) => (isCacheableResponse(fresh) ? cache.put(cacheKey, storedCopy(fresh, limits, now)) : undefined))
            .catch(() => undefined)
        );
      }
      return hit.response;
    }
  }

  const response = await render();
  if (isCacheableResponse(response)) {
    ctx.waitUntil(cache.put(cacheKey, storedCopy(response.clone(), limits, now)).catch(() => undefined));
  }
  return response;
}
