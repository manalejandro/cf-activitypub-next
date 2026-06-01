import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// CORS headers for all API routes (ActivityPub federation + Mastodon API)
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "86400",
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

  // Handle CORS preflight for API routes
  if (method === "OPTIONS" && pathname.startsWith("/api/")) {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  // /inbox and /users/:username/inbox are handled by direct Next.js route files
  // (app/inbox/route.ts and app/users/[username]/inbox/route.ts) — no rewrite needed.

  // Rewrite /users/:username/outbox, /followers, /following → /api/users/:username/...
  const subMatch = pathname.match(
    /^\/users\/([^/]+)\/(outbox|followers|following)$/
  );
  if (subMatch) {
    const url = request.nextUrl.clone();
    url.pathname = `/api/users/${subMatch[1]}/${subMatch[2]}`;
    return NextResponse.rewrite(url);
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
    return rewriteResponse;
  }

  // Add CORS headers to all API responses
  if (pathname.startsWith("/api/")) {
    const response = NextResponse.next();
    Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/users/:path*", "/api/:path*"],
};
