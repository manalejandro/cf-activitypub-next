import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorByUsername } from "@/lib/db";

// GET /.well-known/webfinger?resource=acct:user@domain
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const resource = request.nextUrl.searchParams.get("resource");

  if (!resource) {
    return json({ error: "resource parameter required" }, 400);
  }

  // Support acct:user@domain and https://domain/users/user
  let username: string | null = null;
  const domain = new URL(request.url).hostname;

  if (resource.startsWith("acct:")) {
    const acct = resource.slice(5).replace(/^@/, "");
    const [user, host] = acct.split("@");
    if (host && host.toLowerCase() !== domain.toLowerCase()) {
      return json({ error: "This is not our domain" }, 404);
    }
    username = user;
  } else if (resource.startsWith("https://") || resource.startsWith("http://")) {
    const match = resource.match(/\/users\/([^/]+)$/);
    if (match) username = match[1];
  }

  if (!username) return notFound("Invalid resource");

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("User not found");

  const baseUrl = `https://${domain}`;

  return new Response(
    JSON.stringify({
      subject: `acct:${actor.username}@${domain}`,
      aliases: [`${baseUrl}/users/${actor.username}`],
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
    }),
    {
      headers: {
        "Content-Type": "application/jrd+json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
