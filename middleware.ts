// @opennextjs/cloudflare does not support Node.js middleware, and Next.js 16
// forces any file named `proxy.ts` to run on the Node.js runtime. This file is
// therefore named `middleware.ts` (the legacy convention), which compiles to
// the Edge Runtime that Cloudflare Workers require. It only uses `next/server`,
// so it is fully Edge-compatible.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// CORS headers for all API routes (ActivityPub federation + Mastodon API)
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  // Without this, cross-origin clients (Elk, Phanpy, …) can't read the `Link`
  // pagination header (RFC 8288) and never load the next page of a timeline.
  "Access-Control-Expose-Headers": "Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Vary",
  "Access-Control-Max-Age": "86400",
};

// Security headers applied to all responses
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// AP content types that indicate a federation client
const AP_TYPES = [
  "application/activity+json",
  "application/ld+json",
];

function isAPRequest(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return AP_TYPES.some((t) => accept.includes(t));
}

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const method = request.method;

  // This instance has no Server Actions ("use server" is not used anywhere).
  // A request carrying the Next-Action header is therefore never legitimate:
  // it is either stale client assets from an old build or automated security
  // scanning. Reject it before the Next.js action handler runs, which would
  // otherwise log "Server Reference ID did not match the expected format".
  if (request.headers.has("next-action")) {
    return new NextResponse(null, { status: 404, headers: { ...SECURITY_HEADERS } });
  }

  // Next.js 16 treats any POST to an RSC endpoint as a Server Action
  // invocation. RSC payloads are fetched with GET (client-side navigation);
  // a POST to /RSC/* (often probing random .txt paths) is always invalid for
  // this app — reject it so the framework doesn't log "Failed to find Server
  // Action" for scanner traffic.
  if (method === "POST" && pathname.startsWith("/RSC/")) {
    return new NextResponse(null, { status: 404, headers: { ...SECURITY_HEADERS } });
  }

  // Handle CORS preflight for API and nodeinfo routes
  if (method === "OPTIONS" && (pathname.startsWith("/api/") || pathname.startsWith("/nodeinfo/"))) {
    return new NextResponse(null, { status: 204, headers: { ...CORS_HEADERS, ...SECURITY_HEADERS } });
  }

  // /inbox and /users/:username/inbox are handled by direct Next.js route files
  // (app/inbox/route.ts and app/users/[username]/inbox/route.ts) — no rewrite needed.

  // Rewrite /users/:username/{outbox,followers,following,keyPackages,messages}
  // → /api/users/:username/... (MLS collections added for the RFC 9420 draft).
  const subMatch = pathname.match(
    /^\/users\/([^/]+)\/(outbox|followers|following|keyPackages|messages)$/
  );
  if (subMatch) {
    const url = request.nextUrl.clone();
    url.pathname = `/api/users/${subMatch[1]}/${subMatch[2]}`;
    const rewriteResponse = NextResponse.rewrite(url);
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => rewriteResponse.headers.set(k, v));
    return rewriteResponse;
  }

  // Rewrite /users/:username → /api/users/:username for AP clients (GET only)
  const actorMatch = pathname.match(/^\/users\/([^/]+)$/);
  if (actorMatch && method === "GET" && isAPRequest(request)) {
    const url = request.nextUrl.clone();
    url.pathname = `/api/users/${actorMatch[1]}`;
    // preserve any query params
    searchParams.forEach((v, k) => url.searchParams.set(k, v));
    const rewriteResponse = NextResponse.rewrite(url);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => rewriteResponse.headers.set(k, v));
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => rewriteResponse.headers.set(k, v));
    return rewriteResponse;
  }

  // Rewrite /@username (Mastodon profile URL convention) → /users/username
  // Next.js App Router reserves @ for parallel routes so we can't create app/@[username].
  const atMatch = pathname.match(/^\/@([^/]+)(\/.*)?$/);
  if (atMatch && method === "GET") {
    const username = atMatch[1];
    const rest = atMatch[2] ?? "";
    const url = request.nextUrl.clone();

    // AP clients requesting /@username → serve actor JSON
    if (isAPRequest(request)) {
      url.pathname = `/api/users/${username}`;
      const rewriteResponse = NextResponse.rewrite(url);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => rewriteResponse.headers.set(k, v));
      Object.entries(SECURITY_HEADERS).forEach(([k, v]) => rewriteResponse.headers.set(k, v));
      return rewriteResponse;
    }

    // /@username/statusId → /statuses/statusId (status permalink)
    const statusId = rest.slice(1); // strip leading /
    if (rest && !["with_replies", "media", "followers", "following"].some((p) => statusId.startsWith(p)) &&
        statusId.length > 0) {
      url.pathname = `/statuses/${statusId}`;
    } else {
      url.pathname = `/users/${username}`;
      if (rest) url.searchParams.set("tab", rest.slice(1));
    }
    const rewriteResponse = NextResponse.rewrite(url);
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => rewriteResponse.headers.set(k, v));
    return rewriteResponse;
  }

  // Add security and CORS headers to all API and nodeinfo responses
  if (pathname.startsWith("/api/") || pathname.startsWith("/nodeinfo/")) {
    const response = NextResponse.next();
    Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  }

  // Add security headers to remaining responses
  const response = NextResponse.next();
  Object.entries(SECURITY_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
  return response;
}

export const config = {
  // "/@:path*" compiles to a regex that requires a slash between @ and the username,
  // so it never matches /@ale. Use separate patterns for exact and sub-path cases.
  // The catch-all (excluding static assets) ensures the Next-Action guard also
  // covers the root and any path a scanner may probe with a forged action ID.
  matcher: ["/", "/users/:path*", "/api/:path*", "/nodeinfo/:path*", "/@:username", "/@:username/:path*", "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)"],
};
