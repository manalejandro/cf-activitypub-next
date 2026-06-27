import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// CORS headers — only used for OPTIONS preflight responses.
// Regular response CORS headers are added via next.config.ts headers() config,
// which does NOT interfere with response bodies (unlike NextResponse.next() modifications).
const CORS_PREFLIGHT_HEADERS: Record<string, string> = {
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

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const method = request.method;

  // Handle CORS preflight for API, nodeinfo and well-known routes.
  if (
    method === "OPTIONS" &&
    (pathname.startsWith("/api/") ||
      pathname.startsWith("/nodeinfo/") ||
      pathname.startsWith("/.well-known/"))
  ) {
    return new NextResponse(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
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
    searchParams.forEach((v, k) => url.searchParams.set(k, v));
    return NextResponse.rewrite(url);
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
      return NextResponse.rewrite(url);
    }

    // /@username/statusId → /statuses/statusId (status permalink)
    const statusId = rest.slice(1); // strip leading /
    if (
      rest &&
      !["with_replies", "media", "followers", "following"].some((p) =>
        statusId.startsWith(p)
      ) &&
      statusId.length > 0
    ) {
      url.pathname = `/statuses/${statusId}`;
    } else {
      url.pathname = `/users/${username}`;
      if (rest) url.searchParams.set("tab", rest.slice(1));
    }
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/users/:path*",
    "/api/:path*",
    "/nodeinfo/:path*",
    "/.well-known/:path*",
    "/@:username",
    "/@:username/:path*",
  ],
};
