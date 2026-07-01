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

  const db = env.DB;

  const [userRow, postRow, activeMonthRow, activeHalfyearRow, commentRow] = await Promise.all([
    db.prepare("SELECT COUNT(*) as count FROM actors WHERE is_local = 1").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM objects WHERE is_local = 1").first<{ count: number }>(),
    db.prepare(
      "SELECT COUNT(DISTINCT actor_id) as count FROM objects WHERE is_local = 1 AND published >= datetime('now', '-30 days')"
    ).first<{ count: number }>(),
    db.prepare(
      "SELECT COUNT(DISTINCT actor_id) as count FROM objects WHERE is_local = 1 AND published >= datetime('now', '-180 days')"
    ).first<{ count: number }>(),
    db.prepare(
      "SELECT COUNT(*) as count FROM objects WHERE is_local = 1 AND in_reply_to_id IS NOT NULL"
    ).first<{ count: number }>(),
  ]);

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
        total: userRow?.count ?? 0,
        activeMonth: activeMonthRow?.count ?? 0,
        activeHalfyear: activeHalfyearRow?.count ?? 0,
      },
      localPosts: postRow?.count ?? 0,
      localComments: commentRow?.count ?? 0,
    },
    openRegistrations: true,
  };

  if (version === "2.1") {
    payload.metadata = {
      nodeName: env.INSTANCE_TITLE ?? "CF ActivityPub",
      nodeDescription: env.INSTANCE_DESCRIPTION ?? "",
    };
  }

  return json(payload);
}
