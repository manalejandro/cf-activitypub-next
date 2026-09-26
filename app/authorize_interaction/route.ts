import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";
import { getObjectById, getActorById } from "@/lib/db";
import { encodeStatusId } from "@/lib/mastodon/statusId";
import { getAuthenticatedActor } from "@/lib/auth";

// Response.redirect requires an absolute URL; the Fetch API cannot parse a
// path-only target and throws (remote instances hit this route directly).
function redirectTo(request: NextRequest, path: string): Response {
  return Response.redirect(new URL(path, request.nextUrl.origin), 302);
}

/**
 * Object-ish URIs (statuses/notes) resolve through the status page, which
 * fetches remote objects on demand; anything else is treated as an actor and
 * goes to the remote-profile resolver.
 */
function looksLikeObject(uri: string): boolean {
  try {
    return /\/(objects|statuses|notes|posts)\//i.test(new URL(uri).pathname);
  } catch {
    return false;
  }
}

// GET /authorize_interaction?uri={uri}
//
// Linked from WebFinger (http://ostatus.org/schema/1.0/subscribe) so remote
// clients can jump into an interaction. Resolves the URI to a thread or
// profile; anonymous visitors are sent to the login page (which also offers
// continuing on their own instance) preserving the original URI.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const uri = request.nextUrl.searchParams.get("uri");

  if (!uri) return redirectTo(request, "/login");
  if (!/^https?:\/\//.test(uri)) {
    // Handle / handle@domain or other shorthand: let the resolver page deal.
    return redirectTo(request, `/users/remote?url=${encodeURIComponent(uri)}`);
  }

  let target: string;
  const obj = await getObjectById(env.DB, uri).catch(() => null);
  if (obj) {
    target = `/statuses/${encodeURIComponent(encodeStatusId(uri, obj.local))}`;
  } else {
    const actor = await getActorById(env.DB, uri).catch(() => null);
    if (actor) {
      target = actor.isLocal
        ? `/users/${actor.username}`
        : `/users/remote?url=${encodeURIComponent(uri)}`;
    } else if (looksLikeObject(uri)) {
      // Not cached yet: the status page resolves remote IRIs on demand.
      target = `/statuses/${encodeURIComponent(encodeStatusId(uri, false))}`;
    } else {
      target = `/users/remote?url=${encodeURIComponent(uri)}`;
    }
  }

  // Interacting requires a session. The login page keeps both paths open:
  // sign in here, or continue on the visitor's own instance.
  const me = await getAuthenticatedActor(request, env.DB).catch(() => null);
  if (!me) {
    // Detect the instance the visitor came from so the login page can offer
    // continuing there (the browser sends the origin on cross-site hops).
    let from = "";
    try {
      const host = new URL(request.headers.get("referer") ?? "").hostname;
      if (host && host !== request.nextUrl.hostname) from = `&from=${encodeURIComponent(host)}`;
    } catch { /* no referrer */ }
    return redirectTo(
      request,
      `/login?redirect=${encodeURIComponent(target)}&uri=${encodeURIComponent(uri)}${from}`
    );
  }

  return redirectTo(request, target);
}
