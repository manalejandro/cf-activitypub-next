// Direct ActivityPub shared inbox handler at /inbox.
// Bypasses Next.js middleware rewriting (unreliable for external POST in OpenNext/Cloudflare).
export { POST } from "@/app/api/inbox/route";

import type { NextRequest } from "next/server";

// GET /inbox — return an empty shared OrderedCollection (ActivityPub compliance)
export async function GET(request: NextRequest): Promise<Response> {
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;
  return new Response(
    JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${baseUrl}/inbox`,
      type: "OrderedCollection",
      totalItems: 0,
      first: `${baseUrl}/inbox?page=true`,
    }),
    { status: 200, headers: { "Content-Type": "application/activity+json" } }
  );
}
