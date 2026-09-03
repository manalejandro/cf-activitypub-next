import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";
import { getObjectById, getActorById } from "@/lib/db";

// GET /authorize_interaction?uri={uri}
//
// Linked from WebFinger (http://ostatus.org/schema/1.0/subscribe) so remote
// clients can jump into an interaction. Best-effort resolution: known statuses
// redirect to their thread, actors to their profile, everything else to login.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const uri = request.nextUrl.searchParams.get("uri");

  if (uri) {
    if (/^https?:\/\//.test(uri)) {
      const obj = await getObjectById(env.DB, uri).catch(() => null);
      if (obj) {
        const encoded = Buffer.from(uri).toString("base64url");
        return Response.redirect(`/statuses/${encoded}`, 302);
      }
      const actor = await getActorById(env.DB, uri).catch(() => null);
      if (actor) {
        return Response.redirect(
          actor.isLocal
            ? `/users/${actor.username}`
            : `/users/remote?url=${encodeURIComponent(uri)}`,
          302
        );
      }
    }
    // Remote/local IRI that we don't have cached: resolve on the resolver page.
    return Response.redirect(`/users/remote?url=${encodeURIComponent(uri)}`, 302);
  }

  return Response.redirect("/login", 302);
}