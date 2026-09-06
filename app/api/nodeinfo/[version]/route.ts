import { type NextRequest } from "next/server";
import { getCloudflareContext, notFound } from "@/lib/cf";
import { getInstanceStats } from "@/lib/db";

// GET /nodeinfo/:version
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ version: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { version } = await params;

  if (!version.startsWith("2")) {
    return notFound("Only NodeInfo 2.x is supported");
  }

  // NodeInfo is probed by every instance that discovers this server; a burst
  // of probes must not run 5 count queries against D1 each time. Cache it.
  const cacheKey = `nodeinfo:${version}`;
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  const db = env.DB;
  const stats = await getInstanceStats(db, env.KV);

  const domain = new URL(request.url).hostname;

  const payload: Record<string, unknown> = {
    version,
    software: {
      name: "cf-activitypub",
      version: env.INSTANCE_VERSION ?? "0.1.0",
      repository: "https://github.com/manalejandro/cf-activitypub-next",
      homepage: `https://${domain}`,
    },
    protocols: ["activitypub"],
    services: {
      inbound: [],
      outbound: [],
    },
    usage: {
      users: {
        total: stats.userCount,
        activeMonth: stats.activeMonth,
        activeHalfyear: stats.activeHalfyear,
      },
      localPosts: stats.statusCount,
      localComments: stats.commentCount,
    },
    openRegistrations: true,
  };

  if (version === "2.1") {
    payload.metadata = {
      nodeName: env.INSTANCE_TITLE ?? "CF ActivityPub",
      nodeDescription: env.INSTANCE_DESCRIPTION ?? "",
    };
  }

  const body = JSON.stringify(payload);
  await env.KV.put(cacheKey, body, { expirationTtl: 900 }).catch(() => {});
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
