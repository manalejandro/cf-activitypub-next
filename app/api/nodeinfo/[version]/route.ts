import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";

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

  // Count local users
  const userCount = await env.DB
    .prepare("SELECT COUNT(*) as count FROM actors WHERE is_local = 1")
    .first<{ count: number }>();
  const postCount = await env.DB
    .prepare("SELECT COUNT(*) as count FROM objects WHERE is_local = 1")
    .first<{ count: number }>();

  const domain = new URL(request.url).hostname;

  return json({
    version,
    software: {
      name: "cf-activitypub",
      version: env.INSTANCE_VERSION ?? "0.1.0",
      repository: "https://github.com/manalejandro/cf-activitypub-next",
      homepage: `https://${domain}`,
    },
    protocols: ["activitypub"],
    usage: {
      users: {
        total: userCount?.count ?? 0,
        activeMonth: userCount?.count ?? 0,
        activeHalfyear: userCount?.count ?? 0,
      },
      localPosts: postCount?.count ?? 0,
    },
    openRegistrations: true,
    metadata: {
      nodeName: env.INSTANCE_TITLE ?? "CF ActivityPub",
      nodeDescription: env.INSTANCE_DESCRIPTION ?? "",
    },
  });
}
