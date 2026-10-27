import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorByUsername } from "@/lib/db";
import { env } from "cloudflare:workers";

// GET /.well-known/webfinger?resource=acct:user@domain
export async function GET(request: NextRequest): Promise<Response> {
  const resource = request.nextUrl.searchParams.get("resource");

  if (!resource) {
    return json({ error: "resource parameter required" }, 400);
  }

  // Support acct:user@domain and https://domain/users/user. Both must name
  // OUR domain before anything is looked up or cached: an unvalidated URL
  // branch let a caller mint one KV key per request with a random host
  // prefix (write-quota flooding) and receive our JRD for someone else's
  // resource.
  const domain = new URL(request.url).hostname;
  let username: string | null = null;

  if (resource.startsWith("acct:")) {
    const acct = resource.slice(5).replace(/^@/, "");
    const [user, host] = acct.split("@");
    if (host && host.toLowerCase() !== domain.toLowerCase()) {
      return json({ error: "This is not our domain" }, 404);
    }
    username = user;
  } else if (resource.startsWith("https://") || resource.startsWith("http://")) {
    try {
      const parsed = new URL(resource);
      if (parsed.hostname.toLowerCase() !== domain.toLowerCase()) {
        return json({ error: "This is not our domain" }, 404);
      }
      const match = parsed.pathname.match(/\/users\/([^/]+)$/);
      if (match) username = match[1];
    } catch {
      return notFound("Invalid resource");
    }
  }

  if (!username) return notFound("Invalid resource");

  // Remote instances resolve the same account repeatedly (follows, mentions,
  // re-fetches). Cache the JRD in KV so a burst of resolutions doesn't hammer
  // D1 — keyed by the CANONICAL acct, so every accepted spelling of the same
  // resource shares one entry and a caller cannot vary the key.
  const cacheKey = `ap:webfinger:acct:${username.toLowerCase()}@${domain.toLowerCase()}`;
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/jrd+json; charset=utf-8" },
    });
  }

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("User not found");

  const baseUrl = `https://${domain}`;

  const body = JSON.stringify({
    subject: `acct:${actor.username}@${domain}`,
    aliases: [
      `${baseUrl}/@${actor.username}`,
      `${baseUrl}/users/${actor.username}`,
    ],
    links: [
      {
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: `${baseUrl}/@${actor.username}`,
      },
      {
        rel: "self",
        type: "application/activity+json",
        href: `${baseUrl}/users/${actor.username}`,
      },
      {
        rel: "http://ostatus.org/schema/1.0/subscribe",
        template: `${baseUrl}/authorize_interaction?uri={uri}`,
      },
    ],
  });

  // Cache only successful resolutions; a fresh account must become resolvable
  // immediately, so 404s are never cached.
  await env.KV.put(cacheKey, body, { expirationTtl: 300 }).catch(() => {});

  return new Response(body, {
    headers: {
      "Content-Type": "application/jrd+json; charset=utf-8",
    },
  });
}
