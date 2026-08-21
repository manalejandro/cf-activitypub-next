import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { serializeInstanceV2, serializeAccount } from "@/lib/mastodon/serializers";
import { getInstanceContactActor } from "@/lib/db";

// GET /api/v2/instance
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const [userRow, contactActor] = await Promise.all([
    env.DB
      .prepare("SELECT COUNT(*) as count FROM actors WHERE is_local = 1")
      .first<{ count: number }>(),
    getInstanceContactActor(env.DB),
  ]);

  const userCount = userRow?.count ?? 0;

  const title = env.INSTANCE_TITLE ?? domain;
  const description = env.INSTANCE_DESCRIPTION ?? "An ActivityPub server";
  const version = env.INSTANCE_VERSION ?? "0.1.0";

  return json(
    serializeInstanceV2(
      domain,
      title,
      description,
      version,
      userCount,
      contactActor ? serializeAccount(contactActor, domain) : null,
      env.VAPID_PUBLIC_KEY
    )
  );
}
